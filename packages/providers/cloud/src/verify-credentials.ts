import { z } from 'zod';
import { err, gatewayError, ok, toE164, type GatewayError, type Result } from '@htz/core';
import { GraphClient, type GraphClientOptions } from './graph-client';

/**
 * Connect-screen credential check (C4). Server-only. Calls Graph with the entered
 * Phone Number ID + WABA ID + token and reports a distinct reason for each failure.
 * Never echoes the token (only `last4`).
 */

export const verifyCredentialsInput = z.object({
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{5,20}$/),
  wabaId: z
    .string()
    .trim()
    .regex(/^\d{5,20}$/),
  accessToken: z
    .string()
    .trim()
    .min(20)
    .max(1024)
    .regex(/^[A-Za-z0-9._|-]+$/),
});
export type VerifyCredentialsInput = z.input<typeof verifyCredentialsInput>;

export type VerifyFailureReason =
  | 'invalid_input'
  | 'invalid_token'
  | 'permission_denied'
  | 'phone_number_not_found'
  | 'waba_not_found'
  | 'phone_not_in_waba'
  | 'graph_unavailable';

export interface VerifyCredentialsError extends GatewayError {
  readonly reason: VerifyFailureReason;
}

export interface VerifiedCloudNumber {
  phoneNumberId: string;
  wabaId: string;
  /** E.164 when it is an Israeli number, otherwise Meta's display string as-is. */
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
  tokenLast4: string;
}

/** Plain-language Hebrew copy for the connect screen. */
export const VERIFY_REASON_HE: Record<VerifyFailureReason, string> = {
  invalid_input: 'אחד השדות לא תקין. בדוק שהמזהים מכילים ספרות בלבד ושהטוקן הודבק במלואו.',
  invalid_token: 'ה-Access Token לא תקין או שפג תוקפו. צור טוקן חדש ב-Meta והדבק אותו שוב.',
  permission_denied:
    'לטוקן אין הרשאות WhatsApp מתאימות. הוסף את ההרשאות whatsapp_business_messaging ו-management.',
  phone_number_not_found: 'מזהה מספר הטלפון (Phone Number ID) לא נמצא. העתק אותו שוב מ-Meta.',
  waba_not_found: 'מזהה החשבון העסקי (WABA ID) לא נמצא. העתק אותו שוב מ-Meta.',
  phone_not_in_waba:
    'המספר לא שייך לחשבון העסקי שהוזן. בדוק שה-WABA ID וה-Phone Number ID מאותו חשבון.',
  graph_unavailable: 'לא הצלחנו להגיע ל-Meta כרגע. נסה שוב בעוד דקה.',
};

/** Masks a secret to its last 4 characters; short secrets are fully masked. */
export function last4(secret: string): string {
  const s = secret.trim();
  return s.length >= 12 ? s.slice(-4) : '****';
}

function fail(
  reason: VerifyFailureReason,
  code: GatewayError['code'],
  transient = false,
): { ok: false; error: VerifyCredentialsError } {
  return err({ ...gatewayError(code, reason, { transient }), reason });
}

function fromGraph(
  e: GatewayError,
  notFound: VerifyFailureReason,
): { ok: false; error: VerifyCredentialsError } {
  const d = e.detail ?? '';
  if (e.code === 'invalid_credentials') {
    // 190 = bad/expired token; 10/200 = permission missing
    return /_(10|200)(_|$)/.test(d)
      ? fail('permission_denied', 'invalid_credentials')
      : fail('invalid_token', 'invalid_credentials');
  }
  if (e.transient) return fail('graph_unavailable', e.code, true);
  // 100 (subcode 33) / 803 = object does not exist or no access to it
  if (/^graph_4\d\d_(100|803)(_|$)/.test(d) || d.startsWith('graph_404')) {
    return fail(notFound, 'not_found');
  }
  return fail('graph_unavailable', 'provider_error');
}

export interface VerifyCredentialsDeps {
  graph?: GraphClient;
  graphOptions?: GraphClientOptions;
}

export async function verifyCloudCredentials(
  input: VerifyCredentialsInput,
  deps: VerifyCredentialsDeps = {},
): Promise<Result<VerifiedCloudNumber, VerifyCredentialsError>> {
  const parsed = verifyCredentialsInput.safeParse(input);
  if (!parsed.success) return fail('invalid_input', 'invalid_input');
  const { phoneNumberId, wabaId, accessToken } = parsed.data;
  const graph = deps.graph ?? new GraphClient(deps.graphOptions);

  const phone = await graph.request<{
    id?: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  }>('GET', phoneNumberId, accessToken, {
    query: { fields: 'display_phone_number,verified_name,quality_rating' },
  });
  if (!phone.ok) return fromGraph(phone.error, 'phone_number_not_found');
  if (phone.value.id !== undefined && phone.value.id !== phoneNumberId) {
    return fail('phone_number_not_found', 'not_found');
  }

  const owned = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await graph.request<{
      data?: { id?: string }[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>('GET', `${wabaId}/phone_numbers`, accessToken, {
      query: { fields: 'id', limit: 100, after },
    });
    if (!list.ok) return fromGraph(list.error, 'waba_not_found');
    for (const p of list.value.data ?? []) if (p.id) owned.add(p.id);
    after = list.value.paging?.next ? list.value.paging.cursors?.after : undefined;
    if (!after || owned.has(phoneNumberId)) break;
  }
  if (!owned.has(phoneNumberId)) return fail('phone_not_in_waba', 'invalid_input');

  const display = phone.value.display_phone_number ?? '';
  const e164 = toE164(display);
  return ok({
    phoneNumberId,
    wabaId,
    displayPhoneNumber: e164.ok ? e164.value : display,
    verifiedName: phone.value.verified_name ?? null,
    qualityRating: phone.value.quality_rating ?? null,
    tokenLast4: last4(accessToken),
  });
}
