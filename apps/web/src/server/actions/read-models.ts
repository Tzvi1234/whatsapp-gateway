'use server';

import { z } from 'zod';
import {
  formatE164ForDisplay,
  type Capabilities,
  type LiaTestResult,
  type ProviderKind,
} from '@htz/core';
import { parseUseCasePolicy } from '@htz/policy';
import { requireMemberAal2, requireOwnerAal2 } from '../auth';
import { userClient } from '../supabase';
import { query } from '../db';
import { ACCOUNT_COLUMNS, capabilitiesOf, type AccountRow } from '../repo/accounts';
import { TARGET_COLUMNS, toTargetView, type RelayTargetView, type TargetRow } from '../relay-view';
import { metaWebhookUrl, webhookUrlChanged } from '../urls';
import { fail, fromGatewayError, GENERIC_HE, okResult, type ActionResult } from './result';

/**
 * Read models for the dashboard. All reads use the USER client, so RLS (member/owner +
 * AAL2) applies on top of the guard. No secrets are selected anywhere (S7).
 */

export interface AccountCard {
  id: string;
  label: string;
  provider: ProviderKind;
  alias: string | null;
  phoneE164: string | null;
  phoneDisplay: string | null;
  /** accounts.status (ConnectionState). */
  status: string;
  connection: string | null;
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
  allowedUseCases: string[];
  relay: boolean;
  isTest: boolean;
  capabilities: Capabilities;
}

export interface AlertView {
  id: string;
  severity: 'P1' | 'P2' | 'P3';
  kind: string;
  accountId: string | null;
  message: string | null;
  openedAt: string;
}

export interface HomeData {
  accounts: AccountCard[];
  openAlerts: AlertView[];
  worker: {
    workerId: string;
    version: string | null;
    baileysVersion: string | null;
    at: string;
  } | null;
  failedRate: { provider: string; window: string; total: number; failed: number; rate: number }[];
}

function card(a: AccountRow, s: SessionRow | undefined): AccountCard {
  const policy = parseUseCasePolicy(a.use_case_policy);
  return {
    id: a.id,
    label: a.label,
    provider: a.provider,
    alias: a.alias,
    phoneE164: a.phone_e164,
    phoneDisplay: a.phone_e164 ? formatE164ForDisplay(a.phone_e164) : null,
    status: a.status,
    connection: s?.connection ?? null,
    lastHeartbeatAt: s?.last_heartbeat_at ?? null,
    lastErrorCode: s?.last_error_code ?? null,
    allowedUseCases: policy?.allowed_use_cases ?? [],
    relay: policy?.relay ?? false,
    isTest: a.is_test,
    capabilities: capabilitiesOf(a),
  };
}

interface SessionRow {
  account_id: string;
  connection: string;
  connected_at: string | null;
  last_heartbeat_at: string | null;
  last_error_code: string | null;
}
const SESSION_COLUMNS = 'account_id, connection, connected_at, last_heartbeat_at, last_error_code';

export async function getHomeData(): Promise<ActionResult<HomeData>> {
  const auth = await requireMemberAal2();
  if (!auth.ok) return auth;
  const sb = await userClient();
  const [acc, ses, alerts, hb, fr] = await Promise.all([
    query<AccountRow[]>(
      sb.from('accounts').select(ACCOUNT_COLUMNS).order('created_at'),
      'home.accounts',
    ),
    query<SessionRow[]>(sb.from('sessions').select(SESSION_COLUMNS), 'home.sessions'),
    query<
      {
        id: string;
        severity: AlertView['severity'];
        kind: string;
        account_id: string | null;
        message: string | null;
        opened_at: string;
      }[]
    >(
      sb
        .from('alerts')
        .select('id, severity, kind, account_id, message, opened_at')
        .is('resolved_at', null)
        .order('opened_at', { ascending: false })
        .limit(50),
      'home.alerts',
    ),
    query<
      { worker_id: string; version: string | null; baileys_version: string | null; at: string }[]
    >(
      sb
        .from('worker_heartbeats')
        .select('worker_id, version, baileys_version, at')
        .order('at', { ascending: false })
        .limit(1),
      'home.heartbeat',
    ),
    query<
      {
        provider: string;
        window_name: string;
        total: number;
        failed: number;
        failed_rate: number;
      }[]
    >(
      sb
        .from('v_failed_rate_by_provider')
        .select('provider, window_name, total, failed, failed_rate'),
      'home.failed_rate',
    ),
  ]);
  for (const r of [acc, ses, alerts, hb, fr]) if (!r.ok) return fromGatewayError(r.error);
  if (!acc.ok || !ses.ok || !alerts.ok || !hb.ok || !fr.ok)
    return fail('internal', GENERIC_HE.internal);
  const sessions = new Map((ses.value ?? []).map((s) => [s.account_id, s]));
  const w = hb.value?.[0];
  return okResult({
    accounts: (acc.value ?? []).map((a) => card(a, sessions.get(a.id))),
    openAlerts: (alerts.value ?? []).map((a) => ({
      id: a.id,
      severity: a.severity,
      kind: a.kind,
      accountId: a.account_id,
      message: a.message,
      openedAt: a.opened_at,
    })),
    worker: w
      ? { workerId: w.worker_id, version: w.version, baileysVersion: w.baileys_version, at: w.at }
      : null,
    failedRate: (fr.value ?? []).map((x) => ({
      provider: x.provider,
      window: x.window_name,
      total: Number(x.total),
      failed: Number(x.failed),
      rate: Number(x.failed_rate),
    })),
  });
}

export interface CloudCredentialsView {
  phoneNumberId: string | null;
  wabaId: string | null;
  tokenLast4: string | null;
  appSecretLast4: string | null;
  verifyTokenLast4: string | null;
  lastVerifiedAt: string | null;
  verifiedWebhookUrl: string | null;
  webhookVerifiedAt: string | null;
}

export interface FailedMessageView {
  id: string;
  chat: string;
  kind: string;
  errorCode: string | null;
  createdAt: string;
}

export interface AccountDetail {
  account: AccountCard;
  /** Present only for Cloud accounts and only for the owner (RLS). */
  credentials: CloudCredentialsView | null;
  /** Copy-button value (C6). */
  webhookUrl: string;
  /** C15 banner "הכתובת השתנתה, עדכן ב-Meta". */
  webhookUrlChanged: boolean;
  sessionEvents: { event: string; code: string | null; at: string }[];
  failedMessages: FailedMessageView[];
}

export async function getAccountDetail(accountId: string): Promise<ActionResult<AccountDetail>> {
  const auth = await requireMemberAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(accountId).success) return fail('not_found', GENERIC_HE.not_found);
  const sb = await userClient();
  const a = await query<AccountRow | null>(
    sb.from('accounts').select(ACCOUNT_COLUMNS).eq('id', accountId).maybeSingle(),
    'detail.account',
  );
  if (!a.ok) return fromGatewayError(a.error);
  if (!a.value) return fail('not_found', 'החשבון לא נמצא.');
  const [s, creds, ev, failed] = await Promise.all([
    query<SessionRow | null>(
      sb.from('sessions').select(SESSION_COLUMNS).eq('account_id', accountId).maybeSingle(),
      'detail.session',
    ),
    query<{
      phone_number_id: string | null;
      waba_id: string | null;
      token_last4: string | null;
      app_secret_last4: string | null;
      verify_token_last4: string | null;
      last_verified_at: string | null;
      verified_webhook_url: string | null;
      webhook_verified_at: string | null;
    } | null>(
      sb
        .from('provider_credentials')
        .select(
          'phone_number_id, waba_id, token_last4, app_secret_last4, verify_token_last4, last_verified_at, verified_webhook_url, webhook_verified_at',
        )
        .eq('account_id', accountId)
        .maybeSingle(),
      'detail.credentials',
    ),
    query<{ event: string; code: string | null; at: string }[]>(
      sb
        .from('session_events')
        .select('event, code, at')
        .eq('account_id', accountId)
        .order('at', { ascending: false })
        .limit(20),
      'detail.events',
    ),
    query<
      {
        id: string;
        kind: string;
        error_code: string | null;
        created_at: string;
        conversations: { chat_jid: string } | null;
      }[]
    >(
      sb
        .from('messages')
        .select('id, kind, error_code, created_at, conversations(chat_jid)')
        .eq('account_id', accountId)
        .eq('direction', 'out')
        .eq('status', 'failed')
        .order('created_at', { ascending: false })
        .limit(20),
      'detail.failed',
    ),
  ]);
  if (!s.ok) return fromGatewayError(s.error);
  if (!ev.ok) return fromGatewayError(ev.error);
  if (!failed.ok) return fromGatewayError(failed.error);
  const c = creds.ok ? creds.value : null;
  const credentials: CloudCredentialsView | null = c
    ? {
        phoneNumberId: c.phone_number_id,
        wabaId: c.waba_id,
        tokenLast4: c.token_last4,
        appSecretLast4: c.app_secret_last4,
        verifyTokenLast4: c.verify_token_last4,
        lastVerifiedAt: c.last_verified_at,
        verifiedWebhookUrl: c.verified_webhook_url,
        webhookVerifiedAt: c.webhook_verified_at,
      }
    : null;
  const url = metaWebhookUrl();
  return okResult({
    account: card(a.value, s.value ?? undefined),
    credentials,
    webhookUrl: url,
    webhookUrlChanged: webhookUrlChanged(credentials?.verifiedWebhookUrl ?? null, url),
    sessionEvents: ev.value ?? [],
    failedMessages: (failed.value ?? []).map((m) => ({
      id: m.id,
      chat: m.conversations?.chat_jid ?? '',
      kind: m.kind,
      errorCode: m.error_code,
      createdAt: m.created_at,
    })),
  });
}

export interface RelayBatchView {
  batchId: string;
  status: LiaTestResult['status'] | null;
  isTest: boolean;
  attempts: number;
  createdAt: string;
  acceptedAt: string | null;
  repliedAt: string | null;
}

export interface LiaChannel {
  target: RelayTargetView | null;
  batches: RelayBatchView[];
}

/** Lia channel card + recent deliveries (owner only: the allowlist holds phone numbers). */
export async function getLiaChannel(accountId: string): Promise<ActionResult<LiaChannel>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(accountId).success) return fail('not_found', GENERIC_HE.not_found);
  const sb = await userClient();
  const a = await query<{ provider: ProviderKind } | null>(
    sb.from('accounts').select('provider').eq('id', accountId).maybeSingle(),
    'lia.account',
  );
  if (!a.ok) return fromGatewayError(a.error);
  if (!a.value) return fail('not_found', 'החשבון לא נמצא.');
  const t = await query<TargetRow | null>(
    sb
      .from('relay_targets')
      .select(TARGET_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at')
      .limit(1)
      .maybeSingle(),
    'lia.target',
  );
  if (!t.ok) return fromGatewayError(t.error);
  if (!t.value) return okResult({ target: null, batches: [] });
  const b = await query<
    {
      batch_id: string;
      status: LiaTestResult['status'] | null;
      is_test: boolean;
      attempts: number;
      created_at: string;
      accepted_at: string | null;
      replied_at: string | null;
    }[]
  >(
    sb
      .from('relay_batches')
      .select('batch_id, status, is_test, attempts, created_at, accepted_at, replied_at')
      .eq('relay_target_id', t.value.id)
      .order('created_at', { ascending: false })
      .limit(30),
    'lia.batches',
  );
  if (!b.ok) return fromGatewayError(b.error);
  return okResult({
    target: toTargetView(t.value, a.value.provider),
    batches: (b.value ?? []).map((x) => ({
      batchId: x.batch_id,
      status: x.status,
      isTest: x.is_test,
      attempts: x.attempts,
      createdAt: x.created_at,
      acceptedAt: x.accepted_at,
      repliedAt: x.replied_at,
    })),
  });
}

export type MetricRow = Record<string, string | number | boolean | null>;

export interface HealthMetrics {
  failedRateByProvider: MetricRow[];
  sessionLifetime: MetricRow[];
  reconnectTime: MetricRow[];
  sendLatency: MetricRow[];
  relayFirstResponse: MetricRow[];
  relayNoReplyRate: MetricRow[];
  transcriptLatency: MetricRow[];
  firstConnectFunnel: MetricRow[];
}

const VIEWS: Record<keyof HealthMetrics, string> = {
  failedRateByProvider: 'v_failed_rate_by_provider',
  sessionLifetime: 'v_session_lifetime',
  reconnectTime: 'v_reconnect_time',
  sendLatency: 'v_send_latency',
  relayFirstResponse: 'v_relay_first_response',
  relayNoReplyRate: 'v_relay_no_reply_rate',
  transcriptLatency: 'v_transcript_latency',
  firstConnectFunnel: 'v_first_connect_funnel',
};

/** Health page (ARCH §8.4) from the `v_*` metric views (security_invoker → RLS). */
export async function getHealthMetrics(): Promise<ActionResult<HealthMetrics>> {
  const auth = await requireMemberAal2();
  if (!auth.ok) return auth;
  const sb = await userClient();
  const keys = Object.keys(VIEWS) as (keyof HealthMetrics)[];
  const results = await Promise.all(
    keys.map((k) => query<MetricRow[]>(sb.from(VIEWS[k]).select('*').limit(500), `health.${k}`)),
  );
  const out = {} as HealthMetrics;
  for (let i = 0; i < keys.length; i++) {
    const r = results[i]!;
    if (!r.ok) return fromGatewayError(r.error);
    out[keys[i]!] = (r.value ?? []).map((row) => {
      const clean: MetricRow = {};
      for (const [k, v] of Object.entries(row)) if (k !== 'org_id') clean[k] = v;
      return clean;
    });
  }
  return okResult(out);
}
