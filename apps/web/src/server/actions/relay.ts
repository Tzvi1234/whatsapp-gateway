'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { e164ToJid, formatE164ForDisplay, toE164 } from '@htz/core';
import { parseUseCasePolicy, validateOutboundUrl } from '@htz/policy';
import type { LiaTestResult } from '@htz/core';
import { env } from '../env';
import { requestIp, requireOwnerAal2 } from '../auth';
import { serviceClient } from '../supabase';
import { query, rpc } from '../db';
import { getAccount, type AccountRow } from '../repo/accounts';
import { deliverRelayBatch } from '../internal';
import type { Db } from '../supabase';
import { TARGET_COLUMNS, toTargetView, type RelayTargetView, type TargetRow } from '../relay-view';

export type { RelayTargetView };
import {
  fail,
  fromGatewayError,
  fromZodError,
  GENERIC_HE,
  okResult,
  type ActionResult,
} from './result';

async function loadTarget(db: Db, id: string, orgId: string) {
  const r = await query<TargetRow | null>(
    db.from('relay_targets').select(TARGET_COLUMNS).eq('id', id).maybeSingle(),
    'relay_targets.get',
  );
  if (!r.ok) return fromGatewayError(r.error);
  if (!r.value || r.value.org_id !== orgId) return fail('not_found', GENERIC_HE.not_found);
  return okResult(r.value);
}

/**
 * The send gate reads `accounts.use_case_policy`; keep it in sync with the relay target so
 * Lia may only talk to allowlisted senders (relay=true, agent_relay allowed).
 */
async function syncAccountRelayPolicy(db: Db, account: AccountRow, allowlist: string[]) {
  const cur = parseUseCasePolicy(account.use_case_policy) ?? {
    allowed_use_cases: [],
    may_initiate: false,
    sender_allowlist: [],
    relay: false,
  };
  const next = {
    ...cur,
    relay: true,
    allowed_use_cases: cur.allowed_use_cases.includes('agent_relay')
      ? cur.allowed_use_cases
      : [...cur.allowed_use_cases, 'agent_relay'],
    sender_allowlist: allowlist,
  };
  return query(
    db.from('accounts').update({ use_case_policy: next }).eq('id', account.id),
    'accounts.sync_relay_policy',
  );
}

const targetSchema = z.object({
  accountId: z.uuid(),
  name: z.string().trim().min(1).max(40).default('Lia'),
  url: z.string().trim().min(1).max(2048),
  /** Sender key; omit to keep the stored one. Write-only. */
  secret: z.string().trim().min(16).max(512).optional(),
  debounceMs: z.number().int().min(3000).max(5000).optional(),
  noReplyThresholdMin: z.union([z.literal(5), z.literal(10), z.literal(30)]).optional(),
  enabled: z.boolean().optional(),
});

/** Saves the Lia webhook (SSRF guard on save, S3); key masked (L5.6); URL/key change resets verification (L5.5). */
export async function saveRelayTarget(input: {
  accountId: string;
  name?: string;
  url: string;
  secret?: string;
  debounceMs?: number;
  noReplyThresholdMin?: 5 | 10 | 30;
  enabled?: boolean;
}): Promise<ActionResult<RelayTargetView>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const p = targetSchema.safeParse(input);
  if (!p.success) return fromZodError(p.error);
  const v = p.data;

  const guard = validateOutboundUrl(v.url, { allowedHosts: env().RELAY_ALLOWED_HOSTS });
  if (!guard.ok) {
    return fail(
      'url_not_allowed',
      'הכתובת לא מורשית. מותרות רק כתובות https של דומיין ה-Webhook המאושר.',
      {
        fields: { url: 'הכתובת לא מורשית.' },
      },
    );
  }

  const db = serviceClient();
  const acc = await getAccount(db, v.accountId);
  if (!acc.ok) return fromGatewayError(acc.error);
  if (!acc.value || acc.value.org_id !== auth.data.orgId)
    return fail('not_found', 'החשבון לא נמצא.');
  const ip = await requestIp();

  const id = await rpc<string>(db, 'relay_set_target', {
    p_account_id: v.accountId,
    p_name: v.name,
    p_url: guard.value.url.toString(),
    p_secret: v.secret ?? null,
    p_debounce_ms: v.debounceMs ?? null,
    p_no_reply_threshold_min: v.noReplyThresholdMin ?? null,
    p_enabled: v.enabled ?? null,
    p_actor_user_id: auth.data.userId,
    p_ip: ip,
  });
  if (!id.ok) {
    if (id.error.code === 'invalid_input') {
      return fail('secret_required', 'צריך להזין מפתח שולח (sender key) לערוץ חדש.', {
        fields: { secret: 'שדה חובה.' },
      });
    }
    return fromGatewayError(id.error);
  }

  let t = await loadTarget(db, id.value, auth.data.orgId);
  if (!t.ok) return t;
  // First setup: seed the allowlist from config (LIA_ALLOWLIST_SEED), never from code (C8).
  if (t.data.allowed_senders.length === 0 && env().LIA_ALLOWLIST_SEED.length > 0) {
    const seeded = await rpc<string[]>(db, 'relay_allowlist_update', {
      p_relay_target_id: t.data.id,
      p_allowed_senders: env().LIA_ALLOWLIST_SEED,
      p_actor_user_id: auth.data.userId,
      p_confirmed: true,
      p_ip: ip,
    });
    if (!seeded.ok) return fromGatewayError(seeded.error);
    t = await loadTarget(db, id.value, auth.data.orgId);
    if (!t.ok) return t;
  }
  const synced = await syncAccountRelayPolicy(db, acc.value, t.data.allowed_senders);
  if (!synced.ok) return fromGatewayError(synced.error);
  return okResult(toTargetView(t.data, acc.value.provider));
}

const allowlistSchema = z.object({
  relayTargetId: z.uuid(),
  senders: z.array(z.string().max(32)).max(50),
  confirmed: z.boolean(),
});

export interface AllowlistChange {
  applied: boolean;
  before: string[];
  /** Normalised E.164 list (numbers shown corrected, C7). */
  after: { e164: string; display: string }[];
}

/**
 * Two-step allowlist change (L6.1): call with `confirmed:false` to get the normalised preview,
 * then `confirmed:true` to apply. Audited with before/after by the RPC.
 */
export async function updateAllowlist(input: {
  relayTargetId: string;
  senders: string[];
  confirmed: boolean;
}): Promise<ActionResult<AllowlistChange>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const p = allowlistSchema.safeParse(input);
  if (!p.success) return fromZodError(p.error);
  const normalized: string[] = [];
  const fields: Record<string, string> = {};
  p.data.senders.forEach((s, i) => {
    if (!s.trim()) return;
    const e = toE164(s);
    if (!e.ok) fields[`senders.${i}`] = 'מספר לא תקין.';
    else if (!normalized.includes(e.value)) normalized.push(e.value);
  });
  if (Object.keys(fields).length > 0) {
    return fail('invalid_number', 'אחד המספרים לא תקין. הזן מספרים ישראליים בלבד.', { fields });
  }
  const db = serviceClient();
  const t = await loadTarget(db, p.data.relayTargetId, auth.data.orgId);
  if (!t.ok) return t;
  const after = normalized.map((e) => ({ e164: e, display: formatE164ForDisplay(e) }));
  if (!p.data.confirmed) return okResult({ applied: false, before: t.data.allowed_senders, after });

  const r = await rpc<string[]>(db, 'relay_allowlist_update', {
    p_relay_target_id: t.data.id,
    p_allowed_senders: normalized,
    p_actor_user_id: auth.data.userId,
    p_confirmed: true,
    p_ip: await requestIp(),
  });
  if (!r.ok) return fromGatewayError(r.error);
  const acc = await getAccount(db, t.data.account_id);
  if (acc.ok && acc.value) await syncAccountRelayPolicy(db, acc.value, r.value);
  return okResult({ applied: true, before: t.data.allowed_senders, after });
}

export interface LiaTestOutcome {
  batchId: string;
  /** Canonical status, or null while retries are still pending. */
  status: LiaTestResult['status'] | null;
  lastTest: LiaTestResult | null;
  channel: 'untested' | 'verified';
}

/**
 * Sends the setup-screen test (`is_test: true`, L5.1) right away and records the result.
 * `replied` arrives later when Lia answers via MCP with `reply_to_id = batchId`; poll
 * `getLiaChannel` (status stays `accepted` + `waiting` until then, L4.2).
 */
export async function sendLiaTest(relayTargetId: string): Promise<ActionResult<LiaTestOutcome>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(relayTargetId).success) return fail('not_found', GENERIC_HE.not_found);
  const db = serviceClient();
  const t = await loadTarget(db, relayTargetId, auth.data.orgId);
  if (!t.ok) return t;
  const to = t.data.allowed_senders[0];
  if (!to) {
    return fail('allowlist_empty', 'הוסף לפחות מספר אחד לרשימת המורשים לפני הבדיקה.');
  }
  const now = new Date();
  const msg = await query<{ id: string } | null>(
    db
      .from('messages')
      .insert({
        org_id: t.data.org_id,
        account_id: t.data.account_id,
        direction: 'in',
        kind: 'text',
        body: 'בדיקת חיבור מה-Gateway. נא להשיב באישור קצר בלבד.',
        status: 'delivered',
        provider_message_id: `gw-test:${randomUUID()}`,
        sender_jid: e164ToJid(to),
        relay_state: 'batched',
        received_at: now.toISOString(),
        delivered_at: now.toISOString(),
      })
      .select('id')
      .single(),
    'messages.insert_test',
  );
  if (!msg.ok || !msg.value) return fail('internal', GENERIC_HE.internal);
  const batch = await query<{ batch_id: string } | null>(
    db
      .from('relay_batches')
      .insert({
        org_id: t.data.org_id,
        relay_target_id: t.data.id,
        account_id: t.data.account_id,
        message_ids: [msg.value.id],
        is_test: true,
        first_message_at: now.toISOString(),
        // Leased to this request so the cron deliverer does not POST it concurrently.
        lease_owner: 'dashboard:test',
        lease_until: new Date(now.getTime() + 60_000).toISOString(),
      })
      .select('batch_id')
      .single(),
    'relay_batches.insert_test',
  );
  if (!batch.ok || !batch.value) return fail('internal', GENERIC_HE.internal);
  const batchId = batch.value.batch_id;

  await deliverRelayBatch(db, batchId);

  const st = await query<{ status: LiaTestResult['status'] | null } | null>(
    db.from('relay_batches').select('status').eq('batch_id', batchId).maybeSingle(),
    'relay_batches.status',
  );
  const after = await loadTarget(db, t.data.id, auth.data.orgId);
  if (!after.ok) return after;
  return okResult({
    batchId,
    status: st.ok ? (st.value?.status ?? null) : null,
    lastTest: after.data.last_test,
    channel: after.data.last_verified_at ? 'verified' : 'untested',
  });
}

/** "Resend to Lia": same batch_id and message_ids (L4.8). Delivered by the next cron tick. */
export async function resendRelayBatch(
  batchId: string,
): Promise<ActionResult<{ batchId: string }>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(batchId).success) return fail('not_found', GENERIC_HE.not_found);
  const db = serviceClient();
  const b = await query<{ org_id: string } | null>(
    db.from('relay_batches').select('org_id').eq('batch_id', batchId).maybeSingle(),
    'relay_batches.org',
  );
  if (!b.ok) return fromGatewayError(b.error);
  if (!b.value || b.value.org_id !== auth.data.orgId)
    return fail('not_found', GENERIC_HE.not_found);
  const r = await rpc<boolean>(db, 'relay_resend_batch', { p_batch_id: batchId });
  if (!r.ok) return fromGatewayError(r.error);
  if (!r.value) return fail('conflict', 'אי אפשר לשלוח שוב: ליה כבר ענתה להודעה הזו.');
  return okResult({ batchId });
}
