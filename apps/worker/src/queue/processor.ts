/**
 * Outbound queue executor for Baileys accounts (ARCH §4.2, §8.1, §8.2; ADR-2).
 *
 * Per claimed job: provider id already set → complete only (RL2) → account facts → THE send gate
 * (S13) → session up? → pacing (wait with lease renewals, or reschedule) → provider send →
 * complete_job / fail_job. Every worker send path (MCP/dashboard jobs, Lia replies, relay system
 * replies, status replies, reminders) arrives here, so this is the only place the worker sends.
 */
import {
  USE_CASES,
  type ConnectionState,
  type GatewayErrorCode,
  type OutboundKind,
  type OutboundMessage,
  type UseCase,
  type WhatsAppProvider,
} from '@htz/core';
import type { SendEntryPoint, SendGate } from '@htz/policy';
import type { Pacer } from '@htz/provider-baileys';
import { markdownToWhatsApp } from '@htz/relay';
import type { Logger } from 'pino';
import type { ClaimedJob, WorkerDb } from '../db/types';
import type { AccountDirectory } from '../session/accounts';

/** Idempotency-key prefixes of messages the worker enqueues itself. */
export const RELAY_SYSTEM_KEY_PREFIX = 'relay-sys:';
export const STATUS_REPLY_KEY_PREFIX = 'status-reply:';

export interface QueueDeps {
  db: Pick<
    WorkerDb,
    'claimJobs' | 'renewLease' | 'completeJob' | 'failJob' | 'getConversation' | 'auditAppend'
  >;
  gate: SendGate;
  provider: Pick<WhatsAppProvider, 'send' | 'setPresence'>;
  accounts: AccountDirectory;
  /** Connection state of the session this worker holds for the account, null if none. */
  sessionState(accountId: string): ConnectionState | null;
  /** LID chat → E.164 (Baileys lid-mapping), so the gate can check relay allowlists. */
  resolveChatE164(accountId: string, chatJid: string): Promise<string | null>;
  pacer: Pacer | null;
  workerId: string;
  orgId: string;
  log: Logger;
  /** Jobs per claim. Default 1: a paced job may wait, and unprocessed leases must not expire. */
  batchSize?: number;
  /** Max jobs per pass. Default 50. */
  maxPerPass?: number;
  /** Pacing waits longer than this are rescheduled (fail_job transient). Default 60s. */
  maxPacingWaitMs?: number;
  /** Lease renewal period while waiting (lease is 60s). Default 20s. */
  leaseRenewMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type JobOutcome =
  'completed_existing' | 'sent' | 'gate_rejected' | 'failed' | 'rescheduled' | 'lease_lost';

const isUseCase = (v: string | null): v is UseCase =>
  v !== null && (USE_CASES as readonly string[]).includes(v);

/** Which gate entry point a job belongs to (S13), from the worker's own key prefixes or use case. */
export function entryPointForJob(
  job: Pick<ClaimedJob, 'idempotency_key' | 'use_case'>,
): SendEntryPoint {
  const key = job.idempotency_key ?? '';
  if (key.startsWith(RELAY_SYSTEM_KEY_PREFIX)) return 'relay.system_reply';
  if (key.startsWith(STATUS_REPLY_KEY_PREFIX)) return 'automations.status_reply';
  switch (job.use_case) {
    case 'agent_relay':
      return 'relay.reply';
    case 'status_automation':
      return 'automations.status_reply';
    case 'reminders':
      return 'reminders.dispatch';
    default:
      return 'mcp.send_message';
  }
}

function outboundKind(kind: string): OutboundKind | null {
  return kind === 'text' ||
    kind === 'media' ||
    kind === 'reaction' ||
    kind === 'template' ||
    kind === 'interactive'
    ? kind
    : null;
}

export class QueueProcessor {
  readonly #d: QueueDeps;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #stopping = false;

  constructor(deps: QueueDeps) {
    this.#d = deps;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = deps.now ?? Date.now;
  }

  /** Stop claiming new jobs (SIGTERM). In-flight job finishes. */
  stop(): void {
    this.#stopping = true;
  }

  /** One pass: claim and process until the queue is empty (or the per-pass cap). */
  async runOnce(): Promise<number> {
    let done = 0;
    const max = this.#d.maxPerPass ?? 50;
    while (!this.#stopping && done < max) {
      const jobs = await this.#d.db.claimJobs(this.#d.workerId, this.#d.batchSize ?? 1);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        await this.process(job);
        done += 1;
      }
    }
    return done;
  }

  async process(job: ClaimedJob): Promise<JobOutcome> {
    const d = this.#d;
    const log = d.log.child({ job: job.job_id, correlation_id: job.message_id });
    try {
      return await this.#process(job, log);
    } catch (err) {
      // Unexpected (DB/network): leave the job leased; the lease expires and it is re-claimed.
      log.error(
        { err: (err as Error).name, detail: (err as Error).message?.slice(0, 120) },
        'job_error',
      );
      return 'failed';
    }
  }

  async #fail(
    job: ClaimedJob,
    code: GatewayErrorCode,
    transient: boolean,
    detail: string | null,
    log: Logger,
    entry: SendEntryPoint | null,
  ): Promise<JobOutcome> {
    const state = await this.#d.db.failJob(job.job_id, code, transient, detail);
    log.warn({ code, transient, state }, 'job_failed');
    if (state === 'dead' && entry === 'relay.reply') {
      // L4.6: Lia replied but the reply could not be delivered to Tzvi. relay_mark_delivery_failed
      // is service_role-only, so the worker records it in the audit log for the server to act on.
      await this.#d.db
        .auditAppend(
          this.#d.orgId,
          this.#d.workerId,
          'relay.delivery_failed',
          `message:${job.message_id}`,
          {
            code,
            quoted_provider_id_present: job.quoted_provider_id !== null,
          },
        )
        .catch(() => undefined);
      log.error({ code }, 'relay_delivery_failed');
    }
    return transient && state !== 'dead' ? 'rescheduled' : 'failed';
  }

  async #process(job: ClaimedJob, log: Logger): Promise<JobOutcome> {
    const d = this.#d;

    // RL2: a previous attempt already sent it (or reserved the id) → complete, never resend.
    if (job.provider_message_id) {
      await d.db.completeJob(job.job_id, job.provider_message_id, job.delivery_mode);
      log.info({}, 'job_completed_existing');
      return 'completed_existing';
    }

    const entry = entryPointForJob(job);
    const ctx = await d.accounts.get(job.account_id);
    if (!ctx) return this.#fail(job, 'not_found', false, 'account', log, entry);
    if (!job.chat_jid) return this.#fail(job, 'invalid_input', false, 'no_chat', log, entry);
    const kind = outboundKind(job.kind);
    if (!kind) return this.#fail(job, 'invalid_input', false, `kind:${job.kind}`, log, entry);
    if (!isUseCase(job.use_case))
      return this.#fail(job, 'use_case_not_allowed', false, 'no_use_case', log, entry);

    const conv = job.conversation_id ? await d.db.getConversation(job.conversation_id) : null;
    const chatE164 = await d.resolveChatE164(job.account_id, job.chat_jid).catch(() => null);

    // ---- THE send gate (S13). Fail closed.
    const decision = d.gate.check(entry, {
      accountId: job.account_id,
      policy: ctx.gatePolicy,
      capabilities: ctx.capabilities,
      useCase: job.use_case,
      chat: job.chat_jid,
      chatE164,
      conversation: {
        id: conv?.id ?? job.conversation_id,
        hasInbound: Boolean(conv?.last_inbound_at),
        lastInboundAt: conv?.last_inbound_at ?? null,
      },
      actor: { type: 'system', component: 'worker.queue' },
      kind,
      now: this.#now(),
    });
    if (!decision.ok) {
      log.warn(
        { entry, code: decision.error.code, detail: decision.error.detail ?? null },
        'send_gate_rejected',
      );
      await d.db.failJob(job.job_id, decision.error.code, false, decision.error.detail ?? null);
      return 'gate_rejected';
    }
    const jid = decision.value.chat.jid;

    // ---- session up?
    const state = d.sessionState(job.account_id);
    if (state !== 'open') {
      if (state === 'needs_relink' || state === 'conflict')
        return this.#fail(job, state, false, `session:${state}`, log, entry);
      return this.#fail(
        job,
        'session_disconnected',
        true,
        `session:${state ?? 'none'}`,
        log,
        entry,
      );
    }

    // ---- pacing (ARCH §7.8): wait with lease renewals, or reschedule
    const typing = ctx.capabilities.typingPresence && kind === 'text';
    if (d.pacer) {
      const p = d.pacer.reserve(job.account_id, jid);
      if (!p.ok) return this.#fail(job, 'rate_limited', true, p.reason, log, entry);
      if (p.waitMs > (d.maxPacingWaitMs ?? 60_000))
        return this.#fail(job, 'rate_limited', true, 'pacing', log, entry);
      if (typing)
        await d.provider.setPresence(job.account_id, jid, 'composing').catch(() => undefined);
      const kept = await this.#waitKeepingLease(job, p.waitMs);
      if (typing)
        await d.provider.setPresence(job.account_id, jid, 'paused').catch(() => undefined);
      if (!kept) {
        log.warn({}, 'lease_lost_before_send');
        return 'lease_lost';
      }
    }
    if (!(await d.db.renewLease(job.job_id, d.workerId))) {
      log.warn({}, 'lease_lost_before_send');
      return 'lease_lost';
    }

    // ---- build + send
    const msg: OutboundMessage = {
      accountId: job.account_id,
      to: jid,
      kind,
      idempotencyKey: job.idempotency_key ?? job.message_id,
      useCase: job.use_case,
    };
    if (kind === 'text') {
      const body = job.body ?? '';
      // Lia's Markdown → WhatsApp formatting (ARCH §4.7, L3.11); system replies are plain already.
      msg.text = ctx.isRelay && entry === 'relay.reply' ? markdownToWhatsApp(body) : body;
    } else if (kind === 'media') {
      if (!job.media_path || !job.media_mime)
        return this.#fail(job, 'invalid_input', false, 'missing_media', log, entry);
      msg.media = {
        storagePath: job.media_path,
        mime: job.media_mime,
        ...(job.body ? { caption: job.body } : {}),
      };
    } else if (kind === 'reaction') {
      if (!job.quoted_provider_id || !job.body)
        return this.#fail(job, 'invalid_input', false, 'missing_reaction', log, entry);
      msg.reaction = { targetProviderId: job.quoted_provider_id, emoji: job.body };
    }
    if (job.quoted_provider_id && kind !== 'reaction')
      msg.quotedProviderId = job.quoted_provider_id;

    const res = await d.provider.send(msg);
    if (res.ok && res.providerMessageId) {
      const mode =
        job.delivery_mode ??
        (decision.value.deliveryMode === 'fallback' ? 'fallback' : (res.deliveryMode ?? null));
      await d.db.completeJob(job.job_id, res.providerMessageId, mode);
      log.info({ entry }, 'job_sent');
      return 'sent';
    }
    const e = res.error ?? { code: 'provider_error' as const, transient: true };
    return this.#fail(job, e.code, e.transient, e.detail ?? null, log, entry);
  }

  /** Sleeps `ms`, renewing the 60s lease every `leaseRenewMs`. false = lease lost. */
  async #waitKeepingLease(job: ClaimedJob, ms: number): Promise<boolean> {
    const step = Math.max(1_000, this.#d.leaseRenewMs ?? 20_000);
    let left = ms;
    while (left > 0) {
      const chunk = Math.min(step, left);
      await this.#sleep(chunk);
      left -= chunk;
      if (left > 0 && !(await this.#d.db.renewLease(job.job_id, this.#d.workerId))) return false;
    }
    return true;
  }
}
