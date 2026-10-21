import 'server-only';
import { z } from 'zod';
import { toE164 } from '@htz/core';

/**
 * The ONLY module that reads `process.env` (CODE-STRUCTURE §7). Parsed once with zod on first
 * use (lazy, so `next build` without env vars does not crash at import time) and fails fast
 * with the list of invalid variable NAMES (values are never echoed: some are secrets).
 */

const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

const httpsBaseUrl = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        !v.endsWith('/') &&
        /^https:\/\/[^/?#]+(\/[^?#]*[^/?#])?$/.test(v)
      );
    } catch {
      return false;
    }
  }, 'must be an https URL without trailing slash, query or fragment');

const supabaseUrl = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.hostname));
    } catch {
      return false;
    }
  }, 'must be an https URL (http only for localhost)')
  .transform((v) => v.replace(/\/+$/, ''));

const HOST_RULE = /^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/;

const hostList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  .refine((list) => list.every((h) => HOST_RULE.test(h)), 'comma-separated host names / *.suffix');

const phoneList = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const out: string[] = [];
    for (const raw of (v ?? '').split(',')) {
      if (!raw.trim()) continue;
      const e = toE164(raw);
      if (!e.ok) {
        ctx.addIssue({ code: 'custom', message: 'invalid phone number in list' });
        return z.NEVER;
      }
      if (!out.includes(e.value)) out.push(e.value);
    }
    return out;
  });

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null));

export const envSchema = z.object({
  PUBLIC_BASE_URL: httpsBaseUrl,
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(20),
  INTERNAL_API_SECRET: z.string().trim().min(32),
  /** Grok Bot webhook domains (relay targets). Empty = nothing allowed (fail closed). */
  RELAY_ALLOWED_HOSTS: hostList,
  /** Generic outbound webhook domains; defaults to RELAY_ALLOWED_HOSTS when unset. */
  WEBHOOK_ALLOWED_HOSTS: hostList,
  /** Personal numbers come only from env, never from code (CODE-STRUCTURE §7). */
  LIA_ALLOWLIST_SEED: phoneList,
  TURNSTILE_SECRET: optionalSecret,
});

export type Env = z.output<typeof envSchema> & {
  /** Effective allowlist for generic webhooks. */
  webhookAllowedHosts: string[];
};

export class EnvError extends Error {
  constructor(readonly invalid: readonly string[]) {
    super(`Invalid or missing environment variables: ${invalid.join(', ')}`);
    this.name = 'EnvError';
  }
}

/** Pure parser (testable). Error lists variable names only, never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) {
    const names = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '?')))].sort();
    throw new EnvError(names);
  }
  const d = r.data;
  return {
    ...d,
    webhookAllowedHosts:
      d.WEBHOOK_ALLOWED_HOSTS.length > 0 ? d.WEBHOOK_ALLOWED_HOSTS : d.RELAY_ALLOWED_HOSTS,
  };
}

let cached: Env | null = null;

/** Lazily parsed, cached environment. Throws `EnvError` on first use when invalid. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test seam: override or reset the cached env. */
export function setEnvForTests(value: Env | null): void {
  cached = value;
}

/** Public Supabase settings a client component needs (URL + anon key only). */
export function publicSupabaseConfig(): { url: string; anonKey: string } {
  const e = env();
  return { url: e.NEXT_PUBLIC_SUPABASE_URL, anonKey: e.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}
