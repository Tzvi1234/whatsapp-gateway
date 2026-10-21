'use server';

import QRCode from 'qrcode';
import { z } from 'zod';
import {
  DEFAULT_CAPABILITIES,
  formatE164ForDisplay,
  toE164,
  USE_CASES,
  type ProviderKind,
} from '@htz/core';
import { requestIp, requireOwnerAal2 } from '../auth';
import { serviceClient, userClient } from '../supabase';
import { query, rpc } from '../db';
import { getAccount } from '../repo/accounts';
import { saveCloudCredentialsWith, type SavedCloudCredentials } from '../vault';
import { dashboardResend, dashboardSend } from '../dashboard-send';
import { mcpUrl, metaWebhookUrl } from '../urls';
import {
  fail,
  fromGatewayError,
  fromZodError,
  GENERIC_HE,
  okResult,
  type ActionResult,
} from './result';

/* ------------------------------------------------------------------ accounts */

const createAccountSchema = z.object({
  provider: z.enum(['baileys', 'meta_cloud']),
  label: z.string().trim().min(1).max(80),
  /** Legacy MCP alias (`default` / `meta-default`) or null. */
  alias: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,32}$/)
    .nullish(),
  isTest: z.boolean().default(false),
  useCases: z.array(z.enum(USE_CASES)).max(USE_CASES.length).optional(),
});

const DEFAULT_USE_CASES: Record<ProviderKind, (typeof USE_CASES)[number][]> = {
  baileys: ['customer_service', 'status_automation'],
  meta_cloud: ['reminders', 'notifications'],
};

/** Creates an account row (owner + AAL2). Baileys then pairs; Cloud then saves credentials. */
export async function createAccount(input: {
  provider: ProviderKind;
  label: string;
  alias?: string | null;
  isTest?: boolean;
  useCases?: string[];
}): Promise<ActionResult<{ accountId: string }>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const p = createAccountSchema.safeParse(input);
  if (!p.success) return fromZodError(p.error);
  const db = serviceClient();
  const v = p.data;
  const r = await query<{ id: string } | null>(
    db
      .from('accounts')
      .insert({
        org_id: auth.data.orgId,
        provider: v.provider,
        label: v.label,
        alias: v.alias ?? null,
        is_test: v.isTest,
        capabilities: DEFAULT_CAPABILITIES[v.provider],
        use_case_policy: {
          allowed_use_cases: v.useCases ?? DEFAULT_USE_CASES[v.provider],
          may_initiate: false,
          sender_allowlist: [],
          relay: false,
        },
        status: 'unconfigured',
      })
      .select('id')
      .single(),
    'accounts.create',
  );
  if (!r.ok) {
    if (r.error.code === 'duplicate')
      return fail('duplicate', 'כבר קיים חשבון עם הכינוי או המספר הזה.');
    return fromGatewayError(r.error);
  }
  if (!r.value) return fail('internal', GENERIC_HE.internal);
  await rpc(db, 'audit_append', {
    p_org_id: auth.data.orgId,
    p_actor_type: 'user',
    p_actor_id: auth.data.userId,
    p_action: 'account.create',
    p_target: `account:${r.value.id}`,
    p_ip: await requestIp(),
    p_meta: { provider: v.provider, alias: v.alias ?? null, is_test: v.isTest },
  });
  return okResult({ accountId: r.value.id });
}

async function ownedAccount(accountId: string, orgId: string) {
  const a = await getAccount(serviceClient(), accountId);
  if (!a.ok) return fromGatewayError(a.error);
  if (!a.value || a.value.org_id !== orgId) return fail('not_found', 'החשבון לא נמצא.');
  return okResult(a.value);
}

/* ------------------------------------------------------------------ pairing (Baileys) */

const pairingSchema = z.object({
  accountId: z.uuid(),
  method: z.enum(['qr', 'code']),
  phone: z.string().max(32).optional(),
});

export interface PairingStarted {
  requestId: string;
  method: 'qr' | 'code';
  /** Normalised number for pairing-code flow, shown corrected (C7), else null. */
  phoneE164: string | null;
  phoneDisplay: string | null;
  expiresInSeconds: number;
}

/** QR or 8-char pairing code (C2/C3). The QR/code itself arrives via `getPairingState`/Realtime. */
export async function startPairing(input: {
  accountId: string;
  method: 'qr' | 'code';
  phone?: string;
}): Promise<ActionResult<PairingStarted>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const p = pairingSchema.safeParse(input);
  if (!p.success) return fromZodError(p.error);
  const acc = await ownedAccount(p.data.accountId, auth.data.orgId);
  if (!acc.ok) return acc;
  if (acc.data.provider !== 'baileys')
    return fail('invalid_input', 'חיבור ב-QR מתאים רק לחשבון WhatsApp Web.');

  let phoneE164: string | null = null;
  if (p.data.method === 'code') {
    const e = toE164(p.data.phone ?? '');
    if (!e.ok) {
      return fail('invalid_number', 'מספר הטלפון לא תקין. הזן מספר ישראלי, למשל 050-000-0000.', {
        fields: { phone: 'מספר הטלפון לא תקין.' },
      });
    }
    phoneE164 = e.value;
  }
  const r = await rpc<string>(serviceClient(), 'create_pairing_request', {
    p_account_id: acc.data.id,
    p_requested_by: auth.data.userId,
    p_method: p.data.method === 'qr' ? 'qr' : 'pairing_code',
    p_phone_e164: phoneE164,
    p_ip: await requestIp(),
  });
  if (!r.ok) return fromGatewayError(r.error);
  return okResult({
    requestId: r.value,
    method: p.data.method,
    phoneE164,
    phoneDisplay: phoneE164 ? formatE164ForDisplay(phoneE164) : null,
    expiresInSeconds: 180,
  });
}

export interface PairingState {
  state: 'pending' | 'active' | 'paired' | 'expired' | 'failed' | 'cancelled';
  /** SVG markup of the current QR (render inline), or null. Never logged or cached. */
  qrSvg: string | null;
  pairingCode: string | null;
  qrExpiresAt: string | null;
  requestExpiresAt: string;
}

/**
 * Current QR / pairing code for a request, read through RLS (owner + AAL2 only, R5.3).
 * Poll every ~2 s or subscribe to the private `org:<org_id>:pairing` Realtime topic.
 */
export async function getPairingState(requestId: string): Promise<ActionResult<PairingState>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(requestId).success) return fail('not_found', GENERIC_HE.not_found);
  const sb = await userClient();
  const req = await query<{ state: PairingState['state']; expires_at: string } | null>(
    sb.from('pairing_requests').select('state, expires_at').eq('id', requestId).maybeSingle(),
    'pairing_requests.get',
  );
  if (!req.ok) return fromGatewayError(req.error);
  if (!req.value) return fail('not_found', GENERIC_HE.not_found);
  const qr = await query<{
    qr: string | null;
    pairing_code: string | null;
    expires_at: string;
  } | null>(
    sb
      .from('pairing_qr')
      .select('qr, pairing_code, expires_at')
      .eq('request_id', requestId)
      .maybeSingle(),
    'pairing_qr.get',
  );
  if (!qr.ok) return fromGatewayError(qr.error);
  let qrSvg: string | null = null;
  if (qr.value?.qr) {
    try {
      qrSvg = await QRCode.toString(qr.value.qr, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
      });
    } catch {
      qrSvg = null;
    }
  }
  return okResult({
    state: req.value.state,
    qrSvg,
    pairingCode: qr.value?.pairing_code ?? null,
    qrExpiresAt: qr.value?.expires_at ?? null,
    requestExpiresAt: req.value.expires_at,
  });
}

/* ------------------------------------------------------------------ Cloud API credentials */

/** C4/C5: verified against Graph first; secrets to Vault; only last 4 chars come back. */
export async function saveCloudCredentials(input: {
  accountId: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}): Promise<ActionResult<SavedCloudCredentials>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  return saveCloudCredentialsWith(serviceClient(), input, {
    userId: auth.data.userId,
    orgId: auth.data.orgId,
    ip: await requestIp(),
  });
}

/** URLs for the copy buttons (C6). */
export async function getEndpointUrls(): Promise<
  ActionResult<{ metaWebhookUrl: string; mcpUrl: string }>
> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  return okResult({ metaWebhookUrl: metaWebhookUrl(), mcpUrl: mcpUrl() });
}

/* ------------------------------------------------------------------ one-click actions */

/** Dashboard "Reconnect" → `session_commands(reconnect)` consumed by the worker. */
export async function reconnect(accountId: string): Promise<ActionResult<{ commandId: string }>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const acc = await ownedAccount(accountId, auth.data.orgId);
  if (!acc.ok) return acc;
  const r = await rpc<string>(serviceClient(), 'request_session_command', {
    p_account_id: acc.data.id,
    p_command: 'reconnect',
    p_requested_by: auth.data.userId,
    p_via: 'dashboard',
    p_ip: await requestIp(),
  });
  return r.ok ? okResult({ commandId: r.value }) : fromGatewayError(r.error);
}

/** "Resend" a failed message: new attempt, same message (ARCH §8.2). Passes the send gate. */
export async function resendMessage(
  messageId: string,
): Promise<ActionResult<{ messageId: string; jobId: string }>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(messageId).success) return fail('not_found', GENERIC_HE.not_found);
  const r = await dashboardResend(serviceClient(), auth.data, messageId);
  return r.ok ? okResult(r.value) : fromGatewayError(r.error);
}

const testMessageSchema = z.object({
  accountId: z.uuid(),
  to: z.string().trim().min(3).max(64),
  text: z.string().trim().min(1).max(4096),
});

/** "Send a test message" CTA after connecting. Same send gate as MCP (`dashboard.send`). */
export async function sendTestMessage(input: {
  accountId: string;
  to: string;
  text: string;
}): Promise<ActionResult<{ messageId: string; status: string; errorCode: string | null }>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const p = testMessageSchema.safeParse(input);
  if (!p.success) return fromZodError(p.error);
  const r = await dashboardSend(serviceClient(), auth.data, p.data);
  return r.ok ? okResult(r.value) : fromGatewayError(r.error);
}
