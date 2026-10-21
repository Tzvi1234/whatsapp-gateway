import {
  DEFAULT_CAPABILITIES,
  ok,
  USE_CASES,
  type Capabilities,
  type ProviderKind,
  type Result,
  type UseCase,
} from '@htz/core';
import { parseUseCasePolicy } from '@htz/policy';
import type { Db } from '../supabase';
import { isUuid, query } from '../db';

export const ACCOUNT_COLUMNS =
  'id, org_id, provider, label, alias, phone_e164, status, capabilities, use_case_policy, is_test, created_at';

export interface AccountRow {
  id: string;
  org_id: string;
  provider: ProviderKind;
  label: string;
  alias: string | null;
  phone_e164: string | null;
  status: string;
  capabilities: unknown;
  use_case_policy: unknown;
  is_test: boolean;
  created_at: string;
}

/**
 * Effective capabilities: provider defaults overlaid with the stored jsonb, accepting only
 * known keys whose value has the default's type (a malformed row can never widen access in
 * an unexpected way; `text` is always true).
 */
export function capabilitiesOf(row: Pick<AccountRow, 'provider' | 'capabilities'>): Capabilities {
  const base: Capabilities = { ...DEFAULT_CAPABILITIES[row.provider] };
  const stored = row.capabilities;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  const out = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (k === 'text' || !(k in base)) continue;
    const def = (base as unknown as Record<string, unknown>)[k];
    if (typeof def === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (k === 'groups' && (v === 'full' || v === 'none')) out[k] = v;
    else if (
      (k === 'nativeButtons' || k === 'lists') &&
      (v === 'supported' || v === 'unsupported' || v === 'unverified')
    ) {
      out[k] = v;
    }
  }
  return base;
}

/** Use case assumed when a caller does not name one. */
export function defaultUseCaseOf(row: Pick<AccountRow, 'provider' | 'use_case_policy'>): UseCase {
  const p = parseUseCasePolicy(row.use_case_policy);
  if (p?.relay && p.allowed_use_cases.includes('agent_relay')) return 'agent_relay';
  const first = p?.allowed_use_cases[0];
  if (first && (USE_CASES as readonly string[]).includes(first)) return first;
  return row.provider === 'meta_cloud' ? 'notifications' : 'customer_service';
}

export async function getAccount(db: Db, id: string): Promise<Result<AccountRow | null>> {
  if (!isUuid(id)) return ok(null);
  return query<AccountRow | null>(
    db.from('accounts').select(ACCOUNT_COLUMNS).eq('id', id).maybeSingle(),
    'accounts.get',
  );
}

export async function getAccountByAlias(db: Db, alias: string): Promise<Result<AccountRow | null>> {
  return query<AccountRow | null>(
    db.from('accounts').select(ACCOUNT_COLUMNS).eq('alias', alias).limit(1).maybeSingle(),
    'accounts.by_alias',
  );
}

export async function listAccountsByIds(
  db: Db,
  ids: readonly string[],
): Promise<Result<AccountRow[]>> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return ok([]);
  const r = await query<AccountRow[] | null>(
    db.from('accounts').select(ACCOUNT_COLUMNS).in('id', valid),
    'accounts.list',
  );
  return r.ok ? ok(r.value ?? []) : r;
}

export interface ConversationRow {
  id: string;
  chat_jid: string;
  type: 'direct' | 'group' | 'status';
  title: string | null;
  last_inbound_at: string | null;
  last_message_at: string | null;
}

export const CONVERSATION_COLUMNS = 'id, chat_jid, type, title, last_inbound_at, last_message_at';

export async function getConversation(
  db: Db,
  accountId: string,
  chatJid: string,
): Promise<Result<ConversationRow | null>> {
  return query<ConversationRow | null>(
    db
      .from('conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('account_id', accountId)
      .eq('chat_jid', chatJid)
      .maybeSingle(),
    'conversations.get',
  );
}

/** PN (E.164) for a LID chat via the contacts mapping, or null when unknown. */
export async function e164ForLid(
  db: Db,
  accountId: string,
  lidJid: string,
): Promise<Result<string | null>> {
  const r = await query<{ pn_jid: string | null } | null>(
    db
      .from('contacts')
      .select('pn_jid')
      .eq('account_id', accountId)
      .eq('lid', lidJid)
      .limit(1)
      .maybeSingle(),
    'contacts.by_lid',
  );
  if (!r.ok) return r;
  const pn = r.value?.pn_jid;
  if (!pn) return ok(null);
  const user = pn.split('@')[0]?.split(':')[0] ?? '';
  return ok(/^\d{6,15}$/.test(user) ? `+${user}` : null);
}
