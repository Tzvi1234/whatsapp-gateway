'use server';

import { z } from 'zod';
import { SCOPES } from '@htz/core';
import { generateApiKey } from '@htz/mcp';
import { requestIp, requireOwnerAal2 } from '../auth';
import { ephemeralAnonClient, serviceClient, userClient } from '../supabase';
import { query, rpc, rpcRow } from '../db';
import { mcpUrl } from '../urls';
import {
  AUTH_MESSAGES_HE,
  fail,
  fromGatewayError,
  fromZodError,
  GENERIC_HE,
  okResult,
  type ActionResult,
} from './result';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
    accountIds: z.array(z.uuid()).min(1).max(50),
    /** Required (non-empty) for `relay` keys (L2.2). null/omitted = unrestricted. */
    conversationIds: z.array(z.uuid()).max(100).nullish(),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
    requestsPerMin: z.number().int().min(1).max(600).optional(),
    sendsPerMin: z.number().int().min(1).max(120).optional(),
    /** Re-authentication for a dangerous action (R5.6). Never stored or logged. */
    password: z.string().min(1).max(512),
  })
  .refine(
    (v) => !v.scopes.includes('relay') || (v.conversationIds && v.conversationIds.length > 0),
    { message: 'relay keys must be bound to conversations', path: ['conversationIds'] },
  );

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  /** Plaintext key, shown ONCE. Never retrievable again (S8). */
  token: string;
  mcpUrl: string;
}

/**
 * Creates an MCP API key. Requires the owner's password again (re-auth, R5.6), checked under
 * the same lockout as login. Only `prefix` + SHA-256 hash are stored.
 */
export async function createApiKey(input: {
  name: string;
  scopes: string[];
  accountIds: string[];
  conversationIds?: string[] | null;
  expiresAt?: string | null;
  requestsPerMin?: number;
  sendsPerMin?: number;
  password: string;
}): Promise<ActionResult<CreatedApiKey>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const p = createSchema.safeParse(input);
  if (!p.success) {
    const f = fromZodError(p.error);
    delete f.fields?.password;
    return f;
  }
  const v = p.data;
  const db = serviceClient();
  const ip = await requestIp();

  // Re-auth (R5.6) under the login lockout (R5.1).
  const email = auth.data.email;
  if (!email) return fail('reauth_required', AUTH_MESSAGES_HE.reauth_required);
  const lock = await rpcRow<{ locked: boolean; retry_after_seconds: number }>(
    db,
    'login_check_lockout',
    { p_email: email, p_ip: ip },
  );
  if (!lock.ok || !lock.value) return fail('auth_unavailable', AUTH_MESSAGES_HE.auth_unavailable);
  if (lock.value.locked) {
    return fail('locked', 'יותר מדי ניסיונות כושלים. נסה שוב בעוד 15 דקות.', {
      retryAfterSeconds: lock.value.retry_after_seconds,
    });
  }
  let reauthOk: boolean;
  try {
    const anon = ephemeralAnonClient();
    const r = await anon.auth.signInWithPassword({ email, password: v.password });
    reauthOk = !r.error && r.data.user?.id === auth.data.userId;
    if (!r.error) await anon.auth.signOut({ scope: 'local' }).catch(() => undefined);
  } catch {
    reauthOk = false;
  }
  await rpc(db, 'login_record_attempt', { p_email: email, p_ip: ip, p_success: reauthOk });
  if (!reauthOk) return fail('reauth_failed', AUTH_MESSAGES_HE.reauth_failed);

  const key = generateApiKey();
  const id = await rpc<string>(db, 'create_api_client', {
    p_org_id: auth.data.orgId,
    p_name: v.name,
    p_key_prefix: key.prefix,
    p_key_hash: key.hash,
    p_scopes: v.scopes,
    p_account_ids: v.accountIds,
    p_conversation_ids: v.conversationIds ?? null,
    p_rate_limit: {
      requests_per_min: v.requestsPerMin ?? 60,
      sends_per_min: v.sendsPerMin ?? 20,
    },
    p_expires_at: v.expiresAt ?? null,
    p_legacy: false,
    p_actor_user_id: auth.data.userId,
    p_ip: ip,
  });
  if (!id.ok) return fromGatewayError(id.error);
  return okResult({
    id: id.value,
    name: v.name,
    prefix: key.prefix,
    token: key.token,
    mcpUrl: mcpUrl(),
  });
}

export async function revokeApiKey(id: string): Promise<ActionResult<{ revoked: boolean }>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(id).success) return fail('not_found', GENERIC_HE.not_found);
  const db = serviceClient();
  const own = await query<{ org_id: string } | null>(
    db.from('api_clients').select('org_id').eq('id', id).maybeSingle(),
    'api_clients.org',
  );
  if (!own.ok) return fromGatewayError(own.error);
  if (!own.value || own.value.org_id !== auth.data.orgId)
    return fail('not_found', GENERIC_HE.not_found);
  const r = await rpc<boolean>(db, 'revoke_api_client', {
    p_id: id,
    p_actor_user_id: auth.data.userId,
    p_ip: await requestIp(),
  });
  return r.ok ? okResult({ revoked: r.value }) : fromGatewayError(r.error);
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  accountIds: string[];
  conversationIds: string[] | null;
  legacy: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** Key list for the owner (RLS; `key_hash` is column-excluded, so columns are explicit). */
export async function listApiKeys(): Promise<ActionResult<ApiKeyView[]>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  const sb = await userClient();
  const r = await query<
    {
      id: string;
      name: string;
      key_prefix: string;
      scopes: string[];
      account_ids: string[];
      conversation_ids: string[] | null;
      legacy: boolean;
      created_at: string;
      expires_at: string | null;
      revoked_at: string | null;
      last_used_at: string | null;
    }[]
  >(
    sb
      .from('api_clients')
      .select(
        'id, name, key_prefix, scopes, account_ids, conversation_ids, legacy, created_at, expires_at, revoked_at, last_used_at',
      )
      .order('created_at', { ascending: false }),
    'api_clients.list',
  );
  if (!r.ok) return fromGatewayError(r.error);
  return okResult(
    (r.value ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      scopes: k.scopes,
      accountIds: k.account_ids,
      conversationIds: k.conversation_ids,
      legacy: k.legacy,
      createdAt: k.created_at,
      expiresAt: k.expires_at,
      revokedAt: k.revoked_at,
      lastUsedAt: k.last_used_at,
    })),
  );
}
