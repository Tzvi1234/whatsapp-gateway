/**
 * Status-reply automations (ARCH §9.3 items 1-2, TEST-PLAN R1/R2) on a status-automation account.
 * Decision logic is the pure `@htz/automations` engine; this module loads state, takes the
 * cooldown atomically in the DB (`worker_take_cooldown`, LID+PN keys, R2.2), executes the pacing
 * plan (mark read now, typing, delay) and enqueues the reply through the Outbox → queue → gate.
 */
import {
  DEFAULT_TIMEZONE,
  automationSchema,
  contactKeys,
  evaluateStatusReplies,
  type Automation,
  type LidPnResolver,
  type SkipReason,
} from '@htz/automations';
import type { InboundEvent, Presence } from '@htz/core';
import type { Logger } from 'pino';
import type { AutomationRow, ReplyOutcome, WorkerDb } from '../db/types';
import type { Outbox } from '../queue/outbox';
import type { AccountContext } from '../session/accounts';

export interface StatusSessionOps {
  markRead(chat: string, ids: readonly string[]): Promise<void>;
  presence(chat: string, p: Presence): Promise<void>;
  pnForLid(lid: string): Promise<string | null>;
  lidForPn(pn: string): Promise<string | null>;
}

export interface StatusReplyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface StatusRepliesDeps {
  db: Pick<
    WorkerDb,
    'listAutomations' | 'listStatusReplySendTimes' | 'takeCooldown' | 'recordReplyJob'
  >;
  outbox: Outbox;
  session: (accountId: string) => StatusSessionOps | null;
  log: Logger;
  rng?: () => number;
  now?: () => number;
  timers?: StatusReplyTimers;
}

const RECORDED_SKIPS: ReadonlySet<SkipReason> = new Set([
  'skipped_disabled',
  'skipped_not_direct',
  'skipped_cooldown',
  'skipped_stale',
  'skipped_cap',
  'skipped_no_match',
]);

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
};

export function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** DB row → engine automation. Invalid rows (e.g. no keywords) → null (skipped, logged). */
export function toAutomation(
  row: AutomationRow,
): { automation: Automation; boundStatusId: string | null } | null {
  const binding = row.provider_status_id
    ? { mode: 'specific' as const, statusId: row.provider_status_id }
    : { mode: 'next' as const, armedAt: new Date(row.created_at).toISOString() };
  const parsed = automationSchema.safeParse({
    id: row.id,
    enabled: row.enabled,
    match: {
      keywords: row.keywords,
      mode: row.match_mode,
      caseSensitive: row.case_sensitive,
      ignoreEmoji: row.ignore_emoji,
    },
    reply: {
      text: row.reply_text ?? '',
      options: row.options.map((label) => ({ label })),
      media: row.reply_media_path
        ? { storagePath: row.reply_media_path, mime: guessMime(row.reply_media_path) }
        : null,
      nativeButtons: row.try_native_buttons,
    },
    binding,
  });
  if (!parsed.success) return null;
  // "Next status" automations are bound by worker_upsert_status; until then nothing matches.
  return { automation: parsed.data, boundStatusId: row.provider_status_id };
}

export class StatusReplies {
  readonly #d: StatusRepliesDeps;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(deps: StatusRepliesDeps) {
    this.#d = deps;
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  /** `ev` is a reply to one of the account's statuses (direct chat, not fromMe). */
  async handle(ctx: AccountContext, ev: InboundEvent, inboundMessageId: string): Promise<void> {
    const d = this.#d;
    const accountId = ctx.account.id;
    const now = (d.now ?? Date.now)();
    const rows = await d.db.listAutomations(accountId);
    if (rows.length === 0) return;

    // Pre-resolve LID↔PN (the engine's resolver is synchronous).
    const s = d.session(accountId);
    const map = new Map<string, string>();
    if (s && ev.senderLid && !ev.senderPn) {
      const pn = await s.pnForLid(ev.senderLid).catch(() => null);
      if (pn) map.set(ev.senderLid, pn);
    }
    if (s && ev.senderPn && !ev.senderLid) {
      const lid = await s.lidForPn(ev.senderPn).catch(() => null);
      if (lid) map.set(ev.senderPn, lid);
    }
    const resolver: LidPnResolver = {
      lidToPn: (lid) => map.get(lid) ?? null,
      pnToLid: (pn) => map.get(pn) ?? null,
    };

    const since = new Date(now - 24 * 60 * 60_000).toISOString();
    const sends = await d.db.listStatusReplySendTimes(accountId, since);
    const lastSentAt = sends.length
      ? sends.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b))
      : null;

    const message = {
      chatJid: ev.chat,
      isGroup: ev.isGroup,
      fromMe: ev.fromMe,
      senderPn: ev.senderPn,
      senderLid: ev.senderLid,
      text: ev.text,
      timestamp: ev.timestamp,
      statusReplyToId: ev.statusReplyToId,
      pushName: ev.pushName,
    };
    const record = (
      outcome: ReplyOutcome,
      row: AutomationRow,
      extra: { outbound?: string | null; contactKey?: string | null; detail?: string | null } = {},
    ) =>
      d.db
        .recordReplyJob(accountId, outcome, {
          automationId: row.id,
          statusId: row.status_id,
          inboundMessageId,
          outboundMessageId: extra.outbound ?? null,
          contactKey: extra.contactKey ?? null,
          detail: extra.detail ?? null,
        })
        .catch(() => undefined);

    for (const row of rows) {
      const a = toAutomation(row);
      if (!a) {
        d.log.warn({ automation: row.id }, 'automation_invalid_skipped');
        continue;
      }
      const { reply, skips } = evaluateStatusReplies([a], {
        message,
        now,
        state: { usedCooldownKeys: new Set(), sendTimestamps: sends, lastSentAt },
        capabilities: {
          nativeButtons: ctx.capabilities.nativeButtons,
          lists: ctx.capabilities.lists,
        },
        resolver,
        rng: d.rng ?? Math.random,
        protection: {
          maxAgeMs: Math.max(1, row.max_age_sec) * 1000,
          ...(row.daily_cap !== null ? { dailyCap: row.daily_cap } : {}),
          timezone: DEFAULT_TIMEZONE,
        },
      });
      if (!reply) {
        const reason = skips[0]?.action === 'skip' ? skips[0].reason : null;
        if (reason && RECORDED_SKIPS.has(reason)) await record(reason as ReplyOutcome, row);
        continue;
      }

      // One reply per contact per status, atomically in the DB, under every identity key (R2.2).
      const keys = contactKeys(ev.senderPn, ev.senderLid, resolver);
      let first = true;
      for (const k of keys) {
        const took = await d.db.takeCooldown(accountId, reply.statusId, k, row.id, row.status_id);
        if (!took) first = false;
      }
      if (!first || keys.length === 0) {
        await record('skipped_cooldown', row, { contactKey: keys[0] ?? null });
        return;
      }

      // Pacing plan (R2.5): mark read now, typing for part of the delay, then enqueue.
      if (s) void s.markRead(ev.chat, [ev.providerMessageId]).catch(() => undefined);
      const timers = d.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
      const p = reply.pacing;
      timers.setTimeout(
        () => {
          const live = d.session(accountId);
          if (live) void live.presence(ev.chat, 'composing').catch(() => undefined);
        },
        Math.max(0, p.typingStartAtMs),
      );
      const sent = new Promise<void>((resolve) => {
        timers.setTimeout(
          () => {
            void (async () => {
              const id = await d.outbox.statusReply(
                accountId,
                reply.to,
                {
                  text: reply.reply.text,
                  media: reply.reply.media
                    ? { storagePath: reply.reply.media.storagePath, mime: reply.reply.media.mime }
                    : null,
                  deliveryMode: reply.reply.deliveryMode,
                },
                `${row.id}:${inboundMessageId}`,
              );
              await record(id ? 'queued' : 'failed', row, {
                outbound: id,
                contactKey: keys[0] ?? null,
                detail: id ? null : 'enqueue_failed',
              });
              d.log.info(
                { automation: row.id, correlation_id: inboundMessageId, queued: Boolean(id) },
                'status_reply_scheduled',
              );
            })().finally(resolve);
          },
          Math.max(0, p.sendAtMs),
        );
      });
      this.#pending.add(sent);
      void sent.finally(() => this.#pending.delete(sent));
      return; // first matching automation wins
    }
  }
}
