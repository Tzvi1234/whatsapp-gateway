import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { env } from './env';

export const INTERNAL_SECRET_HEADER = 'x-internal-secret';

/** Constant-time equality for arbitrary strings (hash first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** `/api/internal/*` callers (Supabase Edge Functions) present `x-internal-secret`. */
export function isInternalRequest(
  req: Request,
  secret: string = env().INTERNAL_API_SECRET,
): boolean {
  const given = req.headers.get(INTERNAL_SECRET_HEADER);
  if (!given || !secret) return false;
  return safeEqual(given, secret);
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * Client IP from the platform's trusted header (Vercel sets `x-real-ip` and prepends the
 * client to `x-forwarded-for`). Returns a valid IP literal or null (audit/lockout use it).
 */
export function clientIpFrom(headers: Headers): string | null {
  const candidates = [
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for')?.split(',')[0] ?? null,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && isIP(v)) return v;
  }
  return null;
}
