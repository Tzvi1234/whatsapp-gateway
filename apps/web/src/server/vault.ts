import 'server-only';
import { toE164 } from '@htz/core';
import {
  last4,
  verifyCloudCredentials,
  VERIFY_REASON_HE,
  type VerifiedCloudNumber,
  type VerifyCredentialsError,
  type VerifyCredentialsInput,
} from '@htz/provider-cloud';
import type { Result } from '@htz/core';
import { z } from 'zod';
import type { Db } from './supabase';
import { query, rpc } from './db';
import { getAccount } from './repo/accounts';
import { metaWebhookUrl } from './urls';
import {
  fail,
  fromGatewayError,
  fromZodError,
  okResult,
  type ActionResult,
} from './actions/result';

/**
 * Secrets go straight to Supabase Vault through `security definer` RPCs (CODE-STRUCTURE §7).
 * Nothing here ever returns a secret: only the last 4 characters (C5).
 */

export const cloudCredentialsSchema = z.object({
  accountId: z.uuid(),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{5,20}$/),
  wabaId: z
    .string()
    .trim()
    .regex(/^\d{5,20}$/),
  accessToken: z.string().trim().min(20).max(1024),
  appSecret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/),
  verifyToken: z
    .string()
    .trim()
    .regex(/^[\x21-\x7e]{8,128}$/),
});
export type CloudCredentialsInput = z.input<typeof cloudCredentialsSchema>;

export interface SavedCloudCredentials {
  accountId: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  tokenLast4: string;
  appSecretLast4: string;
  verifyTokenLast4: string;
  /** Exact URL to paste into Meta (copy button, C6). */
  webhookUrl: string;
}

export type CredentialVerifier = (
  input: VerifyCredentialsInput,
) => Promise<Result<VerifiedCloudNumber, VerifyCredentialsError>>;

/**
 * C4/C5: verify with Graph FIRST; on any failure nothing is written and a plain Hebrew
 * reason is returned. On success the secrets go to Vault (`provider_credentials_upsert`).
 */
export async function saveCloudCredentialsWith(
  db: Db,
  raw: unknown,
  actor: { userId: string; orgId: string; ip: string | null },
  verify: CredentialVerifier = (i) => verifyCloudCredentials(i),
): Promise<ActionResult<SavedCloudCredentials>> {
  const parsed = cloudCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    const f = fromZodError(parsed.error);
    return { ...f, code: 'invalid_input', message_he: VERIFY_REASON_HE.invalid_input };
  }
  const input = parsed.data;

  const acc = await getAccount(db, input.accountId);
  if (!acc.ok) return fromGatewayError(acc.error);
  if (!acc.value || acc.value.org_id !== actor.orgId) {
    return fail('not_found', 'החשבון לא נמצא.');
  }
  if (acc.value.provider !== 'meta_cloud') {
    return fail('invalid_input', 'פרטי Meta Cloud API מתאימים רק לחשבון מסוג Cloud API.');
  }

  const verified = await verify({
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessToken: input.accessToken,
  });
  if (!verified.ok) {
    return fail(verified.error.reason, VERIFY_REASON_HE[verified.error.reason]);
  }

  const saved = await rpc<string>(db, 'provider_credentials_upsert', {
    p_account_id: input.accountId,
    p_phone_number_id: input.phoneNumberId,
    p_waba_id: input.wabaId,
    p_access_token: input.accessToken,
    p_app_secret: input.appSecret,
    p_verify_token: input.verifyToken,
    p_verified_webhook_url: null,
    p_actor_user_id: actor.userId,
    p_ip: actor.ip,
  });
  if (!saved.ok) return fromGatewayError(saved.error);

  // Best effort: show the verified number on the account card and mark it connected.
  const e164 = toE164(verified.value.displayPhoneNumber);
  const patch: Record<string, unknown> = { status: 'open' };
  if (e164.ok && !acc.value.phone_e164) patch.phone_e164 = e164.value;
  await query(db.from('accounts').update(patch).eq('id', input.accountId), 'accounts.mark_open');

  return okResult({
    accountId: input.accountId,
    phoneNumberId: verified.value.phoneNumberId,
    wabaId: verified.value.wabaId,
    displayPhoneNumber: verified.value.displayPhoneNumber,
    verifiedName: verified.value.verifiedName,
    tokenLast4: verified.value.tokenLast4,
    appSecretLast4: last4(input.appSecret),
    verifyTokenLast4: last4(input.verifyToken),
    webhookUrl: metaWebhookUrl(),
  });
}
