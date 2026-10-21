/** Closed union of every error code the Gateway can return across a package boundary. */
export const GATEWAY_ERROR_CODES = [
  // auth / access
  'unauthorized',
  'forbidden_scope',
  'forbidden_account',
  'forbidden_chat',
  'rate_limited',
  // policy
  'use_case_not_allowed',
  'outside_24h_window',
  'capability_unsupported',
  'sender_unknown',
  'url_not_allowed',
  // provider / session
  'session_disconnected',
  'needs_relink',
  'conflict',
  'provider_unconfigured',
  'provider_error',
  'invalid_number',
  'invalid_credentials',
  'template_not_found',
  'media_too_large',
  'network',
  'timeout',
  // data
  'not_found',
  'invalid_input',
  'duplicate',
  'internal',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export interface GatewayError {
  readonly code: GatewayErrorCode;
  /** true when retrying later may succeed (network, 429, 5xx, socket down). */
  readonly transient: boolean;
  /** Stable English detail; never contains secrets or full phone numbers. */
  readonly detail?: string;
  readonly retryAfterMs?: number;
}

const TRANSIENT_BY_DEFAULT: ReadonlySet<GatewayErrorCode> = new Set([
  'rate_limited',
  'session_disconnected',
  'provider_error',
  'network',
  'timeout',
]);

export function gatewayError(
  code: GatewayErrorCode,
  detail?: string,
  extra: { transient?: boolean; retryAfterMs?: number } = {},
): GatewayError {
  const e: { -readonly [K in keyof GatewayError]: GatewayError[K] } = {
    code,
    transient: extra.transient ?? TRANSIENT_BY_DEFAULT.has(code),
  };
  if (detail !== undefined) e.detail = detail;
  if (extra.retryAfterMs !== undefined) e.retryAfterMs = extra.retryAfterMs;
  return e;
}

export function isGatewayErrorCode(v: unknown): v is GatewayErrorCode {
  return typeof v === 'string' && (GATEWAY_ERROR_CODES as readonly string[]).includes(v);
}

/** Suggested follow-up action shown to agents and in the dashboard. */
export const ERROR_ACTION: Partial<Record<GatewayErrorCode, string>> = {
  session_disconnected: 'reconnect',
  needs_relink: 'scan_qr',
  conflict: 'check_other_device',
  outside_24h_window: 'use send_template',
  rate_limited: 'retry_later',
  provider_unconfigured: 'add_credentials',
  invalid_credentials: 'fix_credentials',
};
