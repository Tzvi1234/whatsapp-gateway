'use server';

import { z } from 'zod';
import { env } from '../env';
import { serviceClient, userClient } from '../supabase';
import { requestIp } from '../auth';
import { performLogin, verifyTurnstileToken, type LoginNext } from '../login';
import { AUTH_MESSAGES_HE, fail, okResult, type ActionResult } from './result';

/** Email + password login with lockout (R5.1). Next step is always MFA (AAL2 required). */
export async function login(input: {
  email: string;
  password: string;
  turnstileToken?: string;
}): Promise<ActionResult<{ next: LoginNext }>> {
  const ip = await requestIp();
  const turnstileSecret = env().TURNSTILE_SECRET;
  return performLogin(input, {
    db: serviceClient(),
    ip,
    verifyTurnstile: turnstileSecret
      ? (token, addr) => verifyTurnstileToken(turnstileSecret, token, addr)
      : undefined,
    signIn: async (email, password) => {
      const sb = await userClient();
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { ok: false, hasVerifiedTotp: false };
      const f = await sb.auth.mfa.listFactors();
      const hasVerifiedTotp = (f.data?.totp ?? []).some((x) => x.status === 'verified');
      return { ok: true, hasVerifiedTotp };
    },
  });
}

export async function logout(): Promise<ActionResult<null>> {
  try {
    const sb = await userClient();
    await sb.auth.signOut();
  } catch {
    // cookie cleared best-effort
  }
  return okResult(null);
}

export interface MfaStatus {
  authenticated: boolean;
  aal: 'aal1' | 'aal2' | null;
  /** Verified TOTP factor ids (empty = must enroll). */
  verifiedFactorIds: string[];
}

export async function getMfaStatus(): Promise<ActionResult<MfaStatus>> {
  try {
    const sb = await userClient();
    const { data } = await sb.auth.getUser();
    if (!data.user) return okResult({ authenticated: false, aal: null, verifiedFactorIds: [] });
    const aal = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    const f = await sb.auth.mfa.listFactors();
    return okResult({
      authenticated: true,
      aal: aal.data?.currentLevel === 'aal2' ? 'aal2' : 'aal1',
      verifiedFactorIds: (f.data?.totp ?? [])
        .filter((x) => x.status === 'verified')
        .map((x) => x.id),
    });
  } catch {
    return fail('auth_unavailable', AUTH_MESSAGES_HE.auth_unavailable);
  }
}

/**
 * Starts TOTP enrolment for the logged-in (AAL1) user. Returns the QR (SVG data) and the
 * manual-entry secret ONCE, for the user's own authenticator app; never stored by us.
 */
export async function mfaEnroll(): Promise<
  ActionResult<{ factorId: string; qrCodeSvg: string; secret: string; uri: string }>
> {
  try {
    const sb = await userClient();
    const { data: u } = await sb.auth.getUser();
    if (!u.user) return fail('unauthenticated', AUTH_MESSAGES_HE.unauthenticated);
    // Drop stale unverified factors so re-enrolment works.
    const f = await sb.auth.mfa.listFactors();
    for (const x of f.data?.all ?? []) {
      if (x.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: x.id });
    }
    const { data, error } = await sb.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'WhatsApp Gateway',
    });
    if (error || !data)
      return fail('mfa_enroll_failed', 'לא הצלחנו להתחיל את ההרשמה לאימות. נסה שוב.');
    return okResult({
      factorId: data.id,
      qrCodeSvg: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
  } catch {
    return fail('auth_unavailable', AUTH_MESSAGES_HE.auth_unavailable);
  }
}

const verifySchema = z.object({
  factorId: z.string().min(1).max(64).optional(),
  code: z.string().regex(/^\d{6}$/),
});

/** Verifies a TOTP code (enrolment or login) and upgrades the session to AAL2. */
export async function mfaVerify(input: {
  factorId?: string;
  code: string;
}): Promise<ActionResult<{ aal: 'aal2' }>> {
  const p = verifySchema.safeParse(input);
  if (!p.success) return fail('invalid_code', 'הקוד צריך להיות 6 ספרות.');
  try {
    const sb = await userClient();
    let factorId = p.data.factorId;
    if (!factorId) {
      const f = await sb.auth.mfa.listFactors();
      factorId = (f.data?.totp ?? []).find((x) => x.status === 'verified')?.id;
    }
    if (!factorId) return fail('mfa_not_enrolled', 'עוד לא הוגדר אימות דו-שלבי.');
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: p.data.code });
    if (error) return fail('invalid_code', 'הקוד שגוי או שפג תוקפו. נסה את הקוד הנוכחי באפליקציה.');
    return okResult({ aal: 'aal2' });
  } catch {
    return fail('auth_unavailable', AUTH_MESSAGES_HE.auth_unavailable);
  }
}
