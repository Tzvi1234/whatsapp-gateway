import { createHmac, timingSafeEqual } from 'node:crypto';
import { err, gatewayError, ok, type GatewayError, type Result } from '@htz/core';

export const SIGNATURE_HEADER = 'X-Gateway-Signature';
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const SIGNATURE_TOLERANCE_SEC = 300;

const hmacHex = (secret: string, t: number, rawBody: string | Uint8Array): string =>
  createHmac('sha256', secret)
    .update(`${t}.`)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

/** `t=<unix seconds>,v1=<hex HMAC_SHA256(secret, t + "." + raw_body)>` (ARCH §4.7, §7.3). */
export function signWebhook(secret: string, rawBody: string | Uint8Array, nowSec: number): string {
  const t = Math.floor(nowSec);
  return `t=${t},v1=${hmacHex(secret, t, rawBody)}`;
}

/** Headers for every outbound webhook POST (relay batches and generic events). */
export function buildWebhookHeaders(input: {
  secret: string;
  rawBody: string;
  idempotencyKey: string;
  nowSec: number;
}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [SIGNATURE_HEADER]: signWebhook(input.secret, input.rawBody, input.nowSec),
    [IDEMPOTENCY_HEADER]: input.idempotencyKey,
  };
}

function parseHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

/**
 * Receiver-side check (also used by our own tests and by Lia's reference receiver).
 * Accepts any of `secrets` (dual-secret overlap during rotation); constant-time compare;
 * rejects |now − t| > tolerance (L4.9).
 */
export function verifyWebhookSignature(
  header: string | null | undefined,
  rawBody: string | Uint8Array,
  secrets: readonly string[],
  nowSec: number,
  toleranceSec: number = SIGNATURE_TOLERANCE_SEC,
): Result<{ timestamp: number }, GatewayError> {
  if (!header) return err(gatewayError('unauthorized', 'signature_missing'));
  const parsed = parseHeader(header);
  if (!parsed) return err(gatewayError('unauthorized', 'signature_malformed'));
  if (Math.abs(Math.floor(nowSec) - parsed.t) > toleranceSec) {
    return err(gatewayError('unauthorized', 'signature_stale'));
  }
  let match = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(hmacHex(secret, parsed.t, rawBody), 'hex');
    for (const candidate of parsed.v1) {
      const got = Buffer.from(candidate, 'hex');
      // evaluate every pair (no early exit) to keep timing independent of which matched
      if (got.length === expected.length && timingSafeEqual(got, expected)) match = true;
    }
  }
  return match
    ? ok({ timestamp: parsed.t })
    : err(gatewayError('unauthorized', 'signature_mismatch'));
}
