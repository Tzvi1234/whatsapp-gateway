import { z } from 'zod';
import type { Db } from './supabase';
import { rpc, rpcRow } from './db';
import { fail, okResult, type ActionResult } from './actions/result';

/**
 * Login with the legacy lockout preserved (ARCH §7.5, TEST-PLAN R5.1): `login_check_lockout`
 * runs BEFORE Supabase Auth is called; a locked email+IP never reaches Supabase. Lookup errors
 * fail closed. Every password attempt is recorded.
 */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  password: z.string().min(1).max(512),
  turnstileToken: z.string().max(4096).optional(),
});
export type LoginInput = z.input<typeof loginSchema>;

export type LoginNext = 'mfa_enroll' | 'mfa_verify';

export interface LoginDeps {
  db: Db;
  ip: string | null;
  /** Supabase password sign-in (sets the session cookie). */
  signIn: (email: string, password: string) => Promise<{ ok: boolean; hasVerifiedTotp: boolean }>;
  /** Present only when TURNSTILE_SECRET is configured. */
  verifyTurnstile?: ((token: string, ip: string | null) => Promise<boolean>) | undefined;
}

export const LOGIN_HE = {
  invalid: 'האימייל או הסיסמה שגויים.',
  locked: 'יותר מדי ניסיונות כושלים. החשבון נעול ל-15 דקות.',
  captcha: 'האימות האנושי נכשל. רענן את הדף ונסה שוב.',
  unavailable: 'לא הצלחנו לבדוק את ההתחברות כרגע. נסה שוב בעוד רגע.',
} as const;

export async function performLogin(
  raw: unknown,
  deps: LoginDeps,
): Promise<ActionResult<{ next: LoginNext }>> {
  const p = loginSchema.safeParse(raw);
  if (!p.success) return fail('invalid_credentials', LOGIN_HE.invalid);
  const { email, password, turnstileToken } = p.data;

  const lock = await rpcRow<{ locked: boolean; retry_after_seconds: number }>(
    deps.db,
    'login_check_lockout',
    { p_email: email, p_ip: deps.ip },
  );
  if (!lock.ok || !lock.value) return fail('auth_unavailable', LOGIN_HE.unavailable);
  if (lock.value.locked) {
    return fail('locked', LOGIN_HE.locked, {
      retryAfterSeconds: Math.max(1, lock.value.retry_after_seconds),
    });
  }

  if (deps.verifyTurnstile) {
    const human = turnstileToken ? await deps.verifyTurnstile(turnstileToken, deps.ip) : false;
    if (!human) return fail('captcha_failed', LOGIN_HE.captcha);
  }

  let res: { ok: boolean; hasVerifiedTotp: boolean };
  try {
    res = await deps.signIn(email, password);
  } catch {
    res = { ok: false, hasVerifiedTotp: false };
  }
  await rpc(deps.db, 'login_record_attempt', { p_email: email, p_ip: deps.ip, p_success: res.ok });
  if (!res.ok) return fail('invalid_credentials', LOGIN_HE.invalid);
  return okResult({ next: res.hasVerifiedTotp ? 'mfa_verify' : 'mfa_enroll' });
}

/** Cloudflare Turnstile server-side check (fixed Cloudflare endpoint, not user-supplied). */
export async function verifyTurnstileToken(
  secret: string,
  token: string,
  ip: string | null,
): Promise<boolean> {
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
