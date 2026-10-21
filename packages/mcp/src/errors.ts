import { ERROR_ACTION, type GatewayError, type GatewayErrorCode } from '@htz/core';

/** Plain-language copy for every Gateway error code (§6 Errors). */
export const ERROR_MESSAGES: Record<GatewayErrorCode, { he: string; en: string }> = {
  unauthorized: {
    he: 'מפתח ה-API חסר, שגוי, בוטל או שפג תוקפו.',
    en: 'The API key is missing, wrong, revoked or expired.',
  },
  forbidden_scope: {
    he: 'למפתח הזה אין הרשאה לפעולה הזו.',
    en: 'This key does not have the permission (scope) for this tool.',
  },
  forbidden_account: {
    he: 'למפתח הזה אין גישה לחשבון הזה.',
    en: 'This key is not allowed to use this account.',
  },
  forbidden_chat: {
    he: 'למפתח הזה אין הרשאה לשוחח עם הצ׳אט הזה.',
    en: 'This key is not allowed to use this chat.',
  },
  rate_limited: {
    he: 'יותר מדי בקשות. נסה שוב בעוד רגע.',
    en: 'Too many requests. Try again shortly.',
  },
  use_case_not_allowed: {
    he: 'החשבון לא מוגדר לשימוש הזה (למשל פתיחת שיחה חדשה).',
    en: 'This account is not allowed to be used this way (for example starting a new conversation).',
  },
  outside_24h_window: {
    he: 'עברו יותר מ-24 שעות מההודעה האחרונה של הנמען. אפשר לשלוח רק תבנית מאושרת.',
    en: 'More than 24 hours since the recipient last wrote. Only an approved template can be sent.',
  },
  capability_unsupported: {
    he: 'החשבון הזה לא תומך בפעולה הזו.',
    en: 'This account does not support this feature.',
  },
  sender_unknown: {
    he: 'השולח לא נמצא ברשימת המורשים.',
    en: 'The sender is not on the allowlist.',
  },
  url_not_allowed: {
    he: 'הכתובת לא מורשית.',
    en: 'This URL is not allowed.',
  },
  session_disconnected: {
    he: 'החיבור לוואטסאפ מנותק כרגע.',
    en: 'The WhatsApp connection is down right now.',
  },
  needs_relink: {
    he: 'החיבור נותק מהטלפון: סרוק QR מחדש.',
    en: 'The phone unlinked this session: scan the QR code again.',
  },
  conflict: {
    he: 'מכשיר אחר משתמש במספר, או שהפעולה כבר בוצעה.',
    en: 'Another device is using this number, or the action already happened.',
  },
  provider_unconfigured: {
    he: 'חסרים פרטי חיבור ל-Meta עבור החשבון הזה.',
    en: 'Meta Cloud API credentials are missing for this account.',
  },
  provider_error: {
    he: 'ספק וואטסאפ החזיר שגיאה.',
    en: 'The WhatsApp provider returned an error.',
  },
  invalid_number: {
    he: 'מספר הטלפון או מזהה הצ׳אט לא תקין.',
    en: 'The phone number or chat id is not valid.',
  },
  invalid_credentials: {
    he: 'פרטי החיבור ל-Meta שגויים או שפג תוקפם.',
    en: 'The Meta credentials are wrong or expired.',
  },
  template_not_found: {
    he: 'התבנית לא נמצאה או לא אושרה.',
    en: 'The template was not found or is not approved.',
  },
  media_too_large: {
    he: 'הקובץ גדול מדי.',
    en: 'The media file is too large.',
  },
  network: {
    he: 'בעיית רשת זמנית.',
    en: 'Temporary network problem.',
  },
  timeout: {
    he: 'הפעולה לקחה יותר מדי זמן.',
    en: 'The operation timed out.',
  },
  not_found: {
    he: 'הפריט לא נמצא.',
    en: 'Not found.',
  },
  invalid_input: {
    he: 'הפרמטרים שנשלחו לא תקינים.',
    en: 'The parameters are not valid.',
  },
  duplicate: {
    he: 'הבקשה כבר התקבלה.',
    en: 'This request was already received.',
  },
  internal: {
    he: 'שגיאה פנימית. נסה שוב.',
    en: 'Internal error. Please try again.',
  },
};

export interface ToolErrorPayload {
  ok: false;
  code: GatewayErrorCode;
  message_he: string;
  message_en: string;
  action: string | null;
  /** Seconds, only for `rate_limited`. */
  retry_after?: number;
  /** Stable machine detail (e.g. which field failed); never secrets. */
  detail?: string;
}

export function toolError(e: GatewayError): ToolErrorPayload {
  const m = ERROR_MESSAGES[e.code];
  const out: ToolErrorPayload = {
    ok: false,
    code: e.code,
    message_he: m.he,
    message_en: m.en,
    action: ERROR_ACTION[e.code] ?? null,
  };
  if (e.retryAfterMs !== undefined) out.retry_after = Math.max(1, Math.ceil(e.retryAfterMs / 1000));
  if (e.detail !== undefined) out.detail = e.detail;
  return out;
}
