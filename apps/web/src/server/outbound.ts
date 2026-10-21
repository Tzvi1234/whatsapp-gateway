import 'server-only';
import {
  err,
  gatewayError,
  ok,
  type DeliveryMode,
  type ProviderKind,
  type Result,
  type UseCase,
} from '@htz/core';
import type { CloudApiProvider } from '@htz/provider-cloud';
import type { Db } from './supabase';
import { rpc, rpcRow } from './db';
import { createCloudProvider, sendStored, type StoredOutbound } from './cloud';
import { getMessageRow, type MessageRow } from './repo/messages';

/**
 * Shared outbound path AFTER the send gate (never call without a passed `checkSend`):
 * `enqueue_message` (idempotent) → for Cloud accounts the Graph send happens right here and
 * is recorded with `message_record_send_result`; Baileys rows get a worker job.
 */

export interface OutboundInput {
  accountId: string;
  provider: ProviderKind;
  /** Normalised chat JID (from the gate decision). */
  chat: string;
  kind: 'text' | 'media' | 'template';
  text?: string | null;
  media?: { path: string; mime: string; caption?: string | null } | null;
  template?: { name: string; language: string; params: string[] } | null;
  quotedProviderId?: string | null;
  useCase: UseCase;
  apiClientId: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  deliveryMode: DeliveryMode | null;
  requestedAt?: string;
}

interface EnqueueRow {
  message_id: string;
  status: string;
  created: boolean;
  job_id: string | null;
  conversation_id: string | null;
  provider_message_id: string | null;
}

export interface OutboundResult {
  row: MessageRow;
  duplicate: boolean;
}

const WAIT_MS = 5_000;
const WAIT_STEP_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function enqueueAndDispatch(
  db: Db,
  input: OutboundInput,
  opts: { wait?: boolean; provider?: CloudApiProvider } = {},
): Promise<Result<OutboundResult>> {
  const body =
    input.kind === 'media'
      ? (input.media?.caption ?? null)
      : input.kind === 'text'
        ? input.text
        : null;
  const enq = await rpcRow<EnqueueRow>(db, 'enqueue_message', {
    p_account_id: input.accountId,
    p_chat_jid: input.chat,
    p_kind: input.kind,
    p_body: body ?? null,
    p_media_path: input.media?.path ?? null,
    p_media_mime: input.media?.mime ?? null,
    p_template: input.template ?? null,
    p_quoted_provider_id: input.quotedProviderId ?? null,
    p_use_case: input.useCase,
    p_api_client_id: input.apiClientId,
    p_idempotency_key: input.idempotencyKey,
    p_created_by: input.createdBy,
    p_executor: 'auto',
    p_requested_at: input.requestedAt ?? new Date().toISOString(),
    p_delivery_mode: input.deliveryMode,
  });
  if (!enq.ok) return enq;
  if (!enq.value) return err(gatewayError('internal', 'enqueue_no_row', { transient: true }));
  const e = enq.value;

  if (e.created && input.provider === 'meta_cloud') {
    const stored: StoredOutbound = {
      id: e.message_id,
      account_id: input.accountId,
      kind: input.kind,
      body: body ?? null,
      media_path: input.media?.path ?? null,
      media_mime: input.media?.mime ?? null,
      template: input.template ?? null,
      quoted_provider_id: input.quotedProviderId ?? null,
      idempotency_key: input.idempotencyKey,
      use_case: input.useCase,
      chat_jid: input.chat,
    };
    const res = await sendStored(opts.provider ?? createCloudProvider(db), stored);
    const rec = await rpc<string>(db, 'message_record_send_result', {
      p_message_id: e.message_id,
      p_provider_message_id: res.ok ? (res.providerMessageId ?? null) : null,
      p_error_code: res.ok ? null : (res.error?.code ?? 'provider_error'),
      p_transient: res.ok ? false : (res.error?.transient ?? false),
      p_delivery_mode: res.ok ? (res.deliveryMode ?? 'native') : null,
    });
    if (!rec.ok) return rec;
  } else if (e.created && opts.wait) {
    // Baileys: give agents sync semantics (ARCH §4.2), up to ~5 s.
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await sleep(WAIT_STEP_MS);
      const cur = await getMessageRow(db, e.message_id);
      if (cur.ok && cur.value && cur.value.status !== 'queued' && cur.value.status !== 'sending') {
        return ok({ row: cur.value, duplicate: false });
      }
    }
  }

  const row = await getMessageRow(db, e.message_id);
  if (!row.ok) return row;
  if (!row.value) return err(gatewayError('internal', 'message_vanished', { transient: true }));
  return ok({ row: row.value, duplicate: !e.created });
}
