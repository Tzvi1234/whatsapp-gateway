import 'server-only';
import {
  handleVerifyChallenge,
  parseWebhook,
  verifyMetaSignature,
  META_SIGNATURE_HEADER,
} from '@htz/provider-cloud';
import type { Db } from './supabase';
import { query, rpc } from './db';
import { readCloudCredentials } from './cloud';
import { logError, logWarn } from './log';
import { metaWebhookUrl } from './urls';

/**
 * Meta Cloud API webhook (ARCH §4.3, §7.3; TEST-PLAN S1, S2, C6, C15).
 * GET: hub challenge against each Cloud account's Verify Token (wrong → 403).
 * POST: signature over the EXACT raw bytes with the account's App Secret (bad → 401),
 * then idempotent `ingest_inbound` / `apply_message_status`, 200 fast.
 */

export const MAX_WEBHOOK_BYTES = 1024 * 1024;

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

interface CredIndexRow {
  account_id: string;
  phone_number_id: string | null;
}

async function cloudAccountIds(db: Db): Promise<string[] | null> {
  const r = await query<CredIndexRow[] | null>(
    db
      .from('provider_credentials')
      .select('account_id, phone_number_id')
      .not('verify_token_vault_id', 'is', null),
    'provider_credentials.index',
  );
  return r.ok ? (r.value ?? []).map((x) => x.account_id) : null;
}

export async function handleMetaVerify(req: Request, db: Db): Promise<Response> {
  const params = new URL(req.url).searchParams;
  if (params.get('hub.mode') !== 'subscribe' || !params.get('hub.verify_token')) {
    return text(403, 'forbidden');
  }
  const ids = await cloudAccountIds(db);
  if (ids === null) return text(503, 'unavailable');
  let challenge: string | null = null;
  const verifiedAccounts: string[] = [];
  for (const id of ids) {
    const c = await readCloudCredentials(db, id);
    if (!c.ok || !c.value?.verifyToken) continue;
    const r = handleVerifyChallenge(params, c.value.verifyToken);
    if (r.status === 200) {
      challenge = r.body;
      verifiedAccounts.push(id);
    }
  }
  if (challenge === null) return text(403, 'forbidden');
  // C15 baseline: remember which URL Meta verified.
  const url = metaWebhookUrl();
  for (const id of verifiedAccounts) {
    await rpc(db, 'provider_credentials_mark_webhook_verified', { p_account_id: id, p_url: url });
  }
  return text(200, challenge);
}

function phoneNumberIdsOf(json: unknown): string[] {
  const out = new Set<string>();
  const entries = (json as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return [];
  for (const e of entries) {
    const changes = (e as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      const pid = (c as { value?: { metadata?: { phone_number_id?: unknown } } })?.value?.metadata
        ?.phone_number_id;
      if (typeof pid === 'string' && /^\d{5,20}$/.test(pid)) out.add(pid);
    }
  }
  return [...out].slice(0, 20);
}

export async function handleMetaEvent(
  req: Request,
  db: Db,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const header = req.headers.get(META_SIGNATURE_HEADER);
  if (!header) return text(401, 'unauthorized');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_WEBHOOK_BYTES) return text(413, 'too_large');
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength === 0 || raw.byteLength > MAX_WEBHOOK_BYTES) return text(401, 'unauthorized');

  // The JSON is only used to find which account's App Secret to check; nothing is acted on
  // before the signature over the raw bytes verifies.
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text(401, 'unauthorized');
  }
  const phoneIds = phoneNumberIdsOf(json);
  if (phoneIds.length === 0) return text(401, 'unauthorized');

  const idx = await query<CredIndexRow[] | null>(
    db
      .from('provider_credentials')
      .select('account_id, phone_number_id')
      .in('phone_number_id', phoneIds),
    'provider_credentials.by_phone_id',
  );
  if (!idx.ok) return text(503, 'unavailable');

  const verifiedAccountFor = new Map<string, string>();
  for (const row of idx.value ?? []) {
    if (!row.phone_number_id) continue;
    const c = await readCloudCredentials(db, row.account_id);
    if (!c.ok) return text(503, 'unavailable');
    const secret = c.value?.appSecret;
    if (!secret) continue;
    if (verifyMetaSignature(raw, header, secret).ok) {
      verifiedAccountFor.set(row.phone_number_id, row.account_id);
    }
  }
  if (verifiedAccountFor.size === 0) {
    logWarn('meta_webhook_bad_signature', { phone_ids: phoneIds.length });
    return text(401, 'unauthorized');
  }

  const parsed = parseWebhook(json, {
    accountIdFor: (pid) => verifiedAccountFor.get(pid) ?? null,
    now: now(),
  });
  if (!parsed.ok) return text(200, 'ignored');

  for (const item of parsed.value.inbound) {
    const ev = item.event;
    const r = await rpc(db, 'ingest_inbound', {
      p_account_id: ev.accountId,
      p_provider_message_id: ev.providerMessageId,
      p_chat_jid: ev.chat,
      p_kind: ev.type,
      p_body: ev.text,
      p_sender_jid: ev.senderPn,
      p_from_me: false,
      p_push_name: ev.pushName,
      p_received_at: ev.timestamp,
      p_is_forwarded: ev.isForwarded,
      p_quoted_provider_id: ev.quotedProviderId,
      p_media_path: item.mediaId ? `graph-media:${item.mediaId}` : null,
      p_media_mime: ev.media?.mime ?? null,
      p_raw: { type: ev.type, id: ev.providerMessageId, has_media: item.mediaId !== null },
      p_source: 'meta',
      p_chat_type: 'direct',
    });
    if (!r.ok) {
      logError('meta_ingest_failed', { code: r.error.code });
      return text(500, 'retry'); // Meta retries; ingest is idempotent
    }
  }
  for (const s of parsed.value.statuses) {
    const r = await rpc(db, 'apply_message_status', {
      p_account_id: s.accountId,
      p_provider_message_id: s.providerMessageId,
      p_status: s.status,
      p_at: s.timestamp,
      p_error_code: s.errorCode,
    });
    if (!r.ok) {
      logError('meta_status_failed', { code: r.error.code });
      return text(500, 'retry');
    }
  }
  return text(200, 'ok');
}
