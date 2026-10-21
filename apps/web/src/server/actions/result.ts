import type { GatewayError } from '@htz/core';
import { ERROR_MESSAGES } from '@htz/mcp';
import type { z } from 'zod';

/**
 * Uniform server-action result for the UI. `message_he` is plain-language Hebrew ready to
 * show; `code` is a stable English token (render it only under "מה לבדוק").
 */
export type ActionOk<T> = { ok: true; data: T };
export type ActionFail = {
  ok: false;
  code: string;
  message_he: string;
  /** Seconds to wait (lockout / rate limit), when relevant. */
  retryAfterSeconds?: number;
  /** Field name → Hebrew message for form validation errors. */
  fields?: Record<string, string>;
};
export type ActionResult<T> = ActionOk<T> | ActionFail;

export const okResult = <T>(data: T): ActionOk<T> => ({ ok: true, data });

export function fail(
  code: string,
  message_he: string,
  extra: Partial<ActionFail> = {},
): ActionFail {
  return { ok: false, code, message_he, ...extra };
}

/** Auth/session failures shared by every action. */
export const AUTH_MESSAGES_HE = {
  unauthenticated: 'צריך להתחבר מחדש.',
  mfa_required: 'צריך לאמת עם קוד מאפליקציית האימות (TOTP).',
  not_member: 'אין לך גישה לארגון הזה.',
  not_owner: 'רק בעל הארגון יכול לבצע את הפעולה הזו.',
  auth_unavailable: 'לא הצלחנו לבדוק את ההתחברות כרגע. נסה שוב בעוד רגע.',
  reauth_required: 'כדי להמשיך צריך להזין שוב את הסיסמה.',
  reauth_failed: 'הסיסמה שגויה.',
} as const;

export const GENERIC_HE = {
  invalid_input: 'אחד השדות לא תקין. בדוק ונסה שוב.',
  internal: 'משהו השתבש אצלנו. נסה שוב בעוד רגע.',
  not_found: 'לא מצאנו את הפריט המבוקש.',
} as const;

export function fromGatewayError(e: GatewayError): ActionFail {
  const msg = ERROR_MESSAGES[e.code]?.he ?? GENERIC_HE.internal;
  const extra: Partial<ActionFail> = {};
  if (e.retryAfterMs !== undefined) extra.retryAfterSeconds = Math.ceil(e.retryAfterMs / 1000);
  return fail(e.code, msg, extra);
}

/** Validation failure from zod: field-level Hebrew hints (generic; the UI labels the field). */
export function fromZodError(error: z.ZodError): ActionFail {
  const fields: Record<string, string> = {};
  for (const i of error.issues) {
    const k = i.path.map(String).join('.') || '_';
    fields[k] ??= GENERIC_HE.invalid_input;
  }
  return fail('invalid_input', GENERIC_HE.invalid_input, { fields });
}
