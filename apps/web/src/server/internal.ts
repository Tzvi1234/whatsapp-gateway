import 'server-only';
import { z } from 'zod';
import {
  buildRelayPayload,
  buildWebhookHeaders,
  computeLiaTestResult,
  routeInboundType,
} from '@htz/relay';
import {
  guardedFetch,
  type GuardedFetchOptions,
  type SendActor,
  type SendEntryPoint,
} from '@htz/policy';
import {
  err,
  gatewayError,
  isScope,
  normalizeJid,
  USE_CASES,
  type InboundType,
  type OutboundKind,
  type Result,
  type UseCase,
  type RelayMessage,
  type RelayTranscriptEvent,
} from '@htz/core';
import type { CloudApiProvider } from '@htz/provider-cloud';
import type { Db } from './supabase';
import { isUuid, query, rpc } from './db';
import { createCloudProvider, sendStored } from './cloud';
import { chatOf, getMessageRow, toStoredOutbound, type MessageRow } from './repo/messages';
import { checkSend } from './send-gate';
import { isStoragePath, signedMediaUrl } from './media';
import { env } from './env';
import { json } from './http';
import { logError, logWarn } from './log';
import { isGraphMediaPath, materializeCloudMedia } from './cloud-media';

/* ================================================================== cloud-send (R4.5) */

/** Idempotency-key prefix of messages enqueued by the reminder dispatcher. */
export const REMINDER_KEY_PREFIX = 'reminder:';

const isUseCase = (v: string | null | undefined): v is UseCase =>
  typeof v === 'string' && (USE_CASES as readonly string[]).includes(v);

export const cloudSendBody = z.object({
  job_id: z.uuid(),
  message_id: z.uuid(),
  account_id: z.uuid(),
  attempt: z.number().int().min(0).max(100),
  lease_until: z.string().min(1),
});

interface JobRow {
  id: string;
  message_id: string;
  account_id: string;
  state: string;
  lease_until: string | null;
  executor: string;
}

/**
 * Performs the Graph send for one claimed `edge` job (cloud-retry Edge Function) and records
 * the outcome with `complete_job` / `fail_job`. Never sends twice: a row that already has a
 * provider id is completed instead (RL2).
 */
export async function handleCloudSend(
  body: unknown,
  db: Db,
  opts: { provider?: CloudApiProvider; now?: () => Date } = {},
): Promise<Response> {
  const p = cloudSendBody.safeParse(body);
  if (!p.success) return json(400, { ok: false, code: 'invalid_input' });
  const { job_id, message_id, account_id } = p.data;
  const now = (opts.now ?? (() => new Date()))();

  const job = await query<JobRow | null>(
    db
      .from('outbound_queue')
      .select('id, message_id, account_id, state, lease_until, executor')
      .eq('id', job_id)
      .maybeSingle(),
    'outbound_queue.get',
  );
  if (!job.ok) return json(503, { ok: false, code: 'internal' });
  const j = job.value;
  if (!j || j.message_id !== message_id || j.account_id !== account_id || j.executor !== 'edge') {
    return json(404, { ok: false, code: 'not_found' });
  }
  if (j.state !== 'leased' || !j.lease_until || Date.parse(j.lease_until) <= now.getTime()) {
    return json(409, { ok: false, code: 'lease_lost' }); // someone else owns it now
  }

  const m = await getMessageRow(db, message_id);
  if (!m.ok) return json(503, { ok: false, code: 'internal' });
  if (!m.value || m.value.account_id !== account_id)
    return json(404, { ok: false, code: 'not_found' });

  if (m.value.provider_message_id) {
    await rpc(db, 'complete_job', {
      p_job_id: job_id,
      p_provider_message_id: m.value.provider_message_id,
    });
    return json(200, { ok: true, outcome: 'completed_existing' });
  }

  // S13: every retry passes the send gate again (policy, key bindings or the 24h window may have
  // changed since the first attempt). A rejection fails the job permanently with the gate's code.
  const gate = await regateStoredSend(db, m.value, now);
  if (!gate.ok) {
    const r = await rpc<string>(db, 'fail_job', {
      p_job_id: job_id,
      p_error_code: gate.error.code,
      p_transient: false,
      p_detail: gate.error.detail ?? null,
    });
    if (!r.ok) return json(503, { ok: false, code: 'internal' });
    return json(200, { ok: true, outcome: 'gate_rejected', code: gate.error.code });
  }

  const res = await sendStored(opts.provider ?? createCloudProvider(db), toStoredOutbound(m.value));
  if (res.ok && res.providerMessageId) {
    const r = await rpc<boolean>(db, 'complete_job', {
      p_job_id: job_id,
      p_provider_message_id: res.providerMessageId,
      p_delivery_mode: res.deliveryMode ?? 'native',
    });
    if (!r.ok) return json(503, { ok: false, code: 'internal' });
    return json(200, { ok: true, outcome: 'sent' });
  }
  const e = res.error ?? { code: 'provider_error', transient: true };
  const r = await rpc<string>(db, 'fail_job', {
    p_job_id: job_id,
    p_error_code: e.code,
    p_transient: e.transient,
    p_detail: e.detail ?? null,
  });
  if (!r.ok) return json(503, { ok: false, code: 'internal' });
  return json(200, { ok: true, outcome: 'failed', state: r.value, code: e.code });
}

/** Entry point a stored outbound message originally came through (S13 tagging on retries). */
export function entryPointForStored(
  m: Pick<MessageRow, 'idempotency_key' | 'use_case' | 'kind' | 'created_by'>,
): SendEntryPoint {
  if (m.idempotency_key?.startsWith(REMINDER_KEY_PREFIX)) return 'reminders.dispatch';
  if (m.use_case === 'agent_relay') return 'relay.reply';
  if (m.created_by) return 'dashboard.send';
  if (m.kind === 'template') return 'mcp.send_template';
  if (m.kind === 'media') return 'mcp.send_media';
  return 'mcp.send_message';
}

interface ApiClientGateRow {
  id: string;
  scopes: string[] | null;
  account_ids: string[] | null;
  conversation_ids: string[] | null;
  revoked_at: string | null;
  expires_at: string | null;
}

/** Re-runs THE send gate for a stored outbound message (Cloud retries). Fails closed. */
export async function regateStoredSend(db: Db, m: MessageRow, now: Date): Promise<Result<unknown>> {
  let actor: SendActor = { type: 'system', component: 'cloud.retry' };
  if (m.api_client_id) {
    const k = await query<ApiClientGateRow | null>(
      db
        .from('api_clients')
        .select('id, scopes, account_ids, conversation_ids, revoked_at, expires_at')
        .eq('id', m.api_client_id)
        .maybeSingle(),
      'api_clients.gate',
    );
    if (!k.ok) return err(gatewayError('internal', 'gate_key_lookup_failed', { transient: true }));
    const key = k.value;
    if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= now.getTime())) {
      return err(gatewayError('forbidden_scope', 'api_client_inactive', { transient: false }));
    }
    actor = {
      type: 'api_client',
      clientId: key.id,
      scopes: (key.scopes ?? []).filter(isScope),
      accountIds: key.account_ids ?? [],
      conversationIds: key.conversation_ids,
    };
  }
  const kind = m.kind as OutboundKind;
  return checkSend(
    db,
    {
      entryPoint: entryPointForStored(m),
      accountId: m.account_id,
      chat: chatOf(m),
      kind,
      useCase: isUseCase(m.use_case) ? m.use_case : undefined,
      actor,
    },
    now,
  );
}

/* ================================================================== deliver (§4.7, S3) */

export const deliverBody = z.object({
  kind: z.enum(['relay', 'webhook', 'relay_followup']),
  id: z.uuid(),
  attempt: z.number().int().min(0).max(100),
});

export interface DeliverOptions {
  now?: () => Date;
  /** Test seam for the SSRF-guarded HTTPS client (resolver / request injection). */
  fetchOptions?: Partial<GuardedFetchOptions>;
  fetchImpl?: typeof guardedFetch;
  /** Test seam for the Graph media download (Cloud inbound media → Storage). */
  mediaFetch?: typeof fetch;
}

interface BatchRow {
  batch_id: string;
  relay_target_id: string;
  account_id: string;
  message_ids: string[];
  is_test: boolean;
  status: string | null;
  attempts: number;
  created_at: string;
}

interface TargetRow {
  id: string;
  url: string;
  secret_vault_id: string | null;
  enabled: boolean;
  no_reply_threshold_min: number;
}

interface RelayMsgRow {
  id: string;
  org_id: string;
  account_id: string;
  provider_message_id: string | null;
  media_mime: string | null;
  kind: string;
  body: string | null;
  sender_jid: string | null;
  received_at: string | null;
  created_at: string;
  media_path: string | null;
  transcript: string | null;
  quoted_provider_id: string | null;
  is_forwarded: boolean;
}

/** HTTP status to record for a guarded-fetch failure: 0 = network/timeout (retried). */
function statusForFetchError(code: string): number {
  return code === 'url_not_allowed' ? 400 : 0;
}

async function senderE164(db: Db, accountId: string, jid: string | null): Promise<string> {
  if (!jid) return '';
  const n = normalizeJid(jid);
  if (!n.ok) return '';
  if (n.value.e164) return n.value.e164;
  if (n.value.kind === 'lid') {
    const c = await query<{ pn_jid: string | null } | null>(
      db
        .from('contacts')
        .select('pn_jid')
        .eq('account_id', accountId)
        .eq('lid', n.value.jid)
        .limit(1)
        .maybeSingle(),
      'contacts.by_lid',
    );
    const user = c.ok ? c.value?.pn_jid?.split('@')[0] : undefined;
    if (user && /^\d{6,15}$/.test(user)) return `+${user}`;
  }
  return n.value.jid;
}

async function buildRelayMessages(
  db: Db,
  batch: BatchRow,
  opts: DeliverOptions,
): Promise<RelayMessage[] | null> {
  const r = await query<RelayMsgRow[] | null>(
    db
      .from('messages')
      .select(
        'id, org_id, account_id, provider_message_id, kind, body, sender_jid, received_at, created_at, media_path, media_mime, transcript, quoted_provider_id, is_forwarded',
      )
      .in('id', batch.message_ids)
      .eq('account_id', batch.account_id),
    'messages.relay_batch',
  );
  if (!r.ok) return null;
  const byId = new Map((r.value ?? []).map((m) => [m.id, m]));
  const out: RelayMessage[] = [];
  for (const id of batch.message_ids) {
    const m = byId.get(id);
    if (!m) continue;
    const route = routeInboundType(m.kind as InboundType);
    let mediaUrl: string | null = null;
    let mediaPath = m.media_path;
    if (isGraphMediaPath(mediaPath)) {
      // Cloud inbound media is copied into Storage here (deferred from the Meta webhook, so the
      // 200 to Meta never waits on a download). On failure the batch still goes, without a URL.
      const c = await materializeCloudMedia(
        db,
        { ...m, media_path: mediaPath },
        opts.mediaFetch ? { fetchImpl: opts.mediaFetch } : {},
      );
      if (c.ok) mediaPath = c.value;
      else
        logWarn('cloud_media_copy_failed', { code: c.error.code, detail: c.error.detail ?? null });
    }
    if (mediaPath && isStoragePath(mediaPath)) {
      const s = await signedMediaUrl(db, mediaPath);
      mediaUrl = s.ok ? s.value : null;
    }
    out.push({
      message_id: m.id,
      from: await senderE164(db, batch.account_id, m.sender_jid),
      timestamp: m.received_at ?? m.created_at,
      type: 'relay' in route ? route.relay : 'unsupported',
      text: m.body,
      media_url: mediaUrl,
      transcript: m.transcript,
      reply_to_id: m.quoted_provider_id,
      is_forwarded: m.is_forwarded,
    });
  }
  return out;
}

export async function deliverRelayBatch(
  db: Db,
  batchId: string,
  opts: DeliverOptions = {},
): Promise<Response> {
  const now = opts.now ?? (() => new Date());
  const b = await query<BatchRow | null>(
    db
      .from('relay_batches')
      .select(
        'batch_id, relay_target_id, account_id, message_ids, is_test, status, attempts, created_at',
      )
      .eq('batch_id', batchId)
      .maybeSingle(),
    'relay_batches.get',
  );
  if (!b.ok) return json(503, { ok: false, code: 'internal' });
  if (!b.value) return json(404, { ok: false, code: 'not_found' });
  const batch = b.value;
  if (batch.status !== null)
    return json(200, { ok: true, outcome: 'already_final', status: batch.status });

  const t = await query<TargetRow | null>(
    db
      .from('relay_targets')
      .select('id, url, secret_vault_id, enabled, no_reply_threshold_min')
      .eq('id', batch.relay_target_id)
      .maybeSingle(),
    'relay_targets.get',
  );
  if (!t.ok) return json(503, { ok: false, code: 'internal' });
  const target = t.value;

  let httpStatus: number;
  let error: string | null = null;
  const sentAt = now().getTime();

  if (!target || !target.enabled || !target.secret_vault_id) {
    httpStatus = 410;
    error = 'target_disabled_or_missing';
  } else {
    const secret = await rpc<string | null>(db, 'vault_read_secret', {
      p_id: target.secret_vault_id,
    });
    const messages = await buildRelayMessages(db, batch, opts);
    if (!secret.ok || !secret.value || messages === null) {
      return json(503, { ok: false, code: 'internal' }); // lease expires; re-claimed later
    }
    const payload = buildRelayPayload({ batchId: batch.batch_id, isTest: batch.is_test, messages });
    const rawBody = JSON.stringify(payload);
    const headers = buildWebhookHeaders({
      secret: secret.value,
      rawBody,
      idempotencyKey: batch.batch_id,
      nowSec: Math.floor(sentAt / 1000),
    });
    // SSRF guard on EVERY send (S3): https, allowlisted host, DNS re-checked, IP pinned.
    const send = opts.fetchImpl ?? guardedFetch;
    const res = await send(
      target.url,
      { method: 'POST', headers, body: rawBody },
      { ...opts.fetchOptions, allowedHosts: env().RELAY_ALLOWED_HOSTS },
    );
    if (res.ok) {
      httpStatus = res.value.status;
    } else {
      httpStatus = statusForFetchError(res.error.code);
      error = `${res.error.code}:${res.error.detail ?? ''}`;
    }
  }

  const rec = await rpc<string>(db, 'relay_batch_delivery_result', {
    p_batch_id: batch.batch_id,
    p_http_status: httpStatus,
    p_error: error,
  });
  if (!rec.ok) {
    logError('relay_result_record_failed', { code: rec.error.code });
    return json(503, { ok: false, code: 'internal' });
  }

  if (batch.is_test && target && rec.value !== 'retry') {
    const at = now().getTime();
    const delivery =
      rec.value === 'accepted'
        ? ({ status: 'accepted', acceptedAtMs: at } as const)
        : rec.value === 'rejected_key'
          ? ({ status: 'rejected_key', reason: `http_${httpStatus}` } as const)
          : ({ status: 'unreachable', reason: error ?? `http_${httpStatus}` } as const);
    const result = computeLiaTestResult({ sentAtMs: sentAt, nowMs: at, delivery });
    if (result)
      await rpc(db, 'relay_record_test', { p_relay_target_id: target.id, p_result: result });
  }
  return json(200, { ok: true, outcome: rec.value });
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event: string;
  payload: unknown;
  status: string;
  created_at: string;
}

export async function deliverWebhook(
  db: Db,
  id: string,
  opts: DeliverOptions = {},
): Promise<Response> {
  const now = opts.now ?? (() => new Date());
  const d = await query<DeliveryRow | null>(
    db
      .from('webhook_deliveries')
      .select('id, endpoint_id, event, payload, status, created_at')
      .eq('id', id)
      .maybeSingle(),
    'webhook_deliveries.get',
  );
  if (!d.ok) return json(503, { ok: false, code: 'internal' });
  if (!d.value) return json(404, { ok: false, code: 'not_found' });
  const delivery = d.value;
  if (delivery.status === 'delivered' || delivery.status === 'dead') {
    return json(200, { ok: true, outcome: 'already_final', status: delivery.status });
  }
  const e = await query<{ url: string; secret_vault_id: string | null; enabled: boolean } | null>(
    db
      .from('webhook_endpoints')
      .select('url, secret_vault_id, enabled')
      .eq('id', delivery.endpoint_id)
      .maybeSingle(),
    'webhook_endpoints.get',
  );
  if (!e.ok) return json(503, { ok: false, code: 'internal' });
  const endpoint = e.value;

  let code: number;
  let error: string | null = null;
  if (!endpoint || !endpoint.enabled || !endpoint.secret_vault_id) {
    code = 410;
    error = 'endpoint_disabled_or_missing';
  } else {
    const secret = await rpc<string | null>(db, 'vault_read_secret', {
      p_id: endpoint.secret_vault_id,
    });
    if (!secret.ok || !secret.value) return json(503, { ok: false, code: 'internal' });
    const rawBody = JSON.stringify({
      id: delivery.id,
      event: delivery.event,
      created_at: delivery.created_at,
      data: delivery.payload,
    });
    const headers = buildWebhookHeaders({
      secret: secret.value,
      rawBody,
      idempotencyKey: delivery.id,
      nowSec: Math.floor(now().getTime() / 1000),
    });
    const send = opts.fetchImpl ?? guardedFetch;
    const res = await send(
      endpoint.url,
      { method: 'POST', headers, body: rawBody },
      { ...opts.fetchOptions, allowedHosts: env().webhookAllowedHosts },
    );
    if (res.ok) code = res.value.status;
    else {
      code = statusForFetchError(res.error.code);
      error = `${res.error.code}:${res.error.detail ?? ''}`;
    }
  }
  const rec = await rpc<string>(db, 'webhook_delivery_result', {
    p_id: delivery.id,
    p_response_code: code,
    p_error: error,
  });
  if (!rec.ok) return json(503, { ok: false, code: 'internal' });
  return json(200, { ok: true, outcome: rec.value });
}

interface FollowupRow {
  id: string;
  batch_id: string;
  relay_target_id: string;
  message_id: string;
  event: 'transcript';
  transcript: string | null;
  status: string;
}

/**
 * Transcript follow-up for a relay batch (L3.4): `{event:'transcript', batch_id, message_id,
 * transcript}`, signed like batches (same HMAC headers, same sender key, SSRF guard on every send).
 * Idempotency-Key = follow-up id (stable across retries).
 */
export async function deliverRelayFollowup(
  db: Db,
  id: string,
  opts: DeliverOptions = {},
): Promise<Response> {
  const now = opts.now ?? (() => new Date());
  const f = await query<FollowupRow | null>(
    db
      .from('relay_followups')
      .select('id, batch_id, relay_target_id, message_id, event, transcript, status')
      .eq('id', id)
      .maybeSingle(),
    'relay_followups.get',
  );
  if (!f.ok) return json(503, { ok: false, code: 'internal' });
  if (!f.value) return json(404, { ok: false, code: 'not_found' });
  const fu = f.value;
  if (fu.status === 'delivered' || fu.status === 'dead') {
    return json(200, { ok: true, outcome: 'already_final', status: fu.status });
  }
  const t = await query<TargetRow | null>(
    db
      .from('relay_targets')
      .select('id, url, secret_vault_id, enabled, no_reply_threshold_min')
      .eq('id', fu.relay_target_id)
      .maybeSingle(),
    'relay_targets.get',
  );
  if (!t.ok) return json(503, { ok: false, code: 'internal' });
  const target = t.value;

  let httpStatus: number;
  let error: string | null = null;
  if (!target || !target.enabled || !target.secret_vault_id) {
    httpStatus = 410;
    error = 'target_disabled_or_missing';
  } else {
    const secret = await rpc<string | null>(db, 'vault_read_secret', {
      p_id: target.secret_vault_id,
    });
    if (!secret.ok || !secret.value) return json(503, { ok: false, code: 'internal' });
    const event: RelayTranscriptEvent = {
      event: 'transcript',
      batch_id: fu.batch_id,
      message_id: fu.message_id,
      transcript: fu.transcript,
    };
    const rawBody = JSON.stringify(event);
    const headers = buildWebhookHeaders({
      secret: secret.value,
      rawBody,
      idempotencyKey: fu.id,
      nowSec: Math.floor(now().getTime() / 1000),
    });
    const send = opts.fetchImpl ?? guardedFetch;
    const res = await send(
      target.url,
      { method: 'POST', headers, body: rawBody },
      { ...opts.fetchOptions, allowedHosts: env().RELAY_ALLOWED_HOSTS },
    );
    if (res.ok) httpStatus = res.value.status;
    else {
      httpStatus = statusForFetchError(res.error.code);
      error = `${res.error.code}:${res.error.detail ?? ''}`;
    }
  }
  const rec = await rpc<string>(db, 'relay_followup_delivery_result', {
    p_id: fu.id,
    p_http_status: httpStatus,
    p_error: error,
  });
  if (!rec.ok) return json(503, { ok: false, code: 'internal' });
  return json(200, { ok: true, outcome: rec.value });
}

export async function handleDeliver(
  body: unknown,
  db: Db,
  opts: DeliverOptions = {},
): Promise<Response> {
  const p = deliverBody.safeParse(body);
  if (!p.success || !isUuid(p.data.id)) return json(400, { ok: false, code: 'invalid_input' });
  switch (p.data.kind) {
    case 'relay':
      return deliverRelayBatch(db, p.data.id, opts);
    case 'relay_followup':
      return deliverRelayFollowup(db, p.data.id, opts);
    default:
      return deliverWebhook(db, p.data.id, opts);
  }
}
