/**
 * Worker configuration (CODE-STRUCTURE §3: validate at the edge with zod, fail fast).
 * `process.env` is read only by `main.ts`, which passes it here once at boot.
 *
 * Production file: `~/.config/gateway/worker.env` (mode 0600, EnvironmentFile= of the systemd
 * unit). The session master key is NOT an env var: it comes from `$CREDENTIALS_DIRECTORY/session.key`
 * (systemd LoadCredential=) or `SESSION_KEY_FILE`, loaded by `loadMasterKey` (0600/0400 only).
 */
import path from 'node:path';
import { z } from 'zod';
import { toE164 } from '@htz/core';

export const POLL_MIN_MS = 30_000;
export const POLL_MAX_MS = 60_000;
export const WORKER_JWT_ROLE = 'gateway_worker';

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid worker config: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const bool = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v, ctx) => {
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['', '0', 'false', 'no', 'off'].includes(v)) return false;
    ctx.addIssue({ code: 'custom', message: 'must be true/false' });
    return z.NEVER;
  });

const int = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  SUPABASE_URL: z
    .string()
    .trim()
    .url()
    .refine((u) => {
      let p: URL;
      try {
        p = new URL(u);
      } catch {
        return false;
      }
      return (
        p.protocol === 'https:' ||
        (p.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(p.hostname))
      );
    }, 'https only (http allowed for localhost)')
    .transform((u) => u.replace(/\/+$/, '')),
  SUPABASE_WORKER_JWT: z.string().trim().min(20),
  /** Public anon/publishable key sent as `apikey` (Supabase API gateway). Optional. */
  SUPABASE_ANON_KEY: z.string().trim().min(10).optional(),
  WORKER_ID: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, '1-64 chars [A-Za-z0-9._-]'),
  ORG_ID: z.string().trim().uuid(),
  SESSION_KEY_FILE: z.string().trim().min(1).optional(),
  CREDENTIALS_DIRECTORY: z.string().trim().min(1).optional(),
  TRANSCRIBER_SOCKET: z.string().trim().min(1).optional(),
  XDG_RUNTIME_DIR: z.string().trim().min(1).optional(),
  TRANSCRIBER_TIMEOUT_MS: int(1_000, 15 * 60_000).default(180_000),
  SONIOX_ENABLED: bool.default(false),
  SONIOX_API_KEY: z.string().trim().min(1).optional(),
  LIA_ALLOWLIST_SEED: z.string().default(''),
  STORAGE_BUCKET: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{1,62}$/)
    .default('media'),
  POLL_INTERVAL_MS: int(POLL_MIN_MS, POLL_MAX_MS).default(45_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Minimum level shipped to `worker_logs` (always redacted). */
  LOG_SHIP_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  WORKER_VERSION: z.string().trim().max(64).optional(),
});

export interface WorkerConfig {
  supabaseUrl: string;
  workerJwt: string;
  /** Value of the `apikey` header; the worker JWT itself when no anon key is configured. */
  apiKey: string;
  workerId: string;
  orgId: string;
  sessionKey: { keyFile: string | undefined; credentialsDirectory: string | undefined };
  transcriber: { socketPath: string; timeoutMs: number };
  /** null unless SONIOX_ENABLED=true AND SONIOX_API_KEY is set (paid; Tzvi decides). */
  soniox: { apiKey: string } | null;
  /** Soniox flag was on but the key is missing (logged as a warning at boot). */
  sonioxMisconfigured: boolean;
  /** E.164 numbers from env only (never from code/fixtures). */
  liaAllowlistSeed: string[];
  storageBucket: string;
  pollIntervalMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  logShipLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug';
  version: string;
}

/** Decodes (does not verify) a JWT payload. Returns null for anything that is not a JWT. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The worker must authenticate as `gateway_worker` (ARCH §5/§7.2), never with the service-role
 * key. Refuses a JWT whose role is anything else, and an `apikey` that is a service-role JWT.
 */
export function checkWorkerJwt(jwt: string, anonKey: string | undefined, nowMs: number): string[] {
  const issues: string[] = [];
  const claims = decodeJwtPayload(jwt);
  if (!claims) {
    issues.push('SUPABASE_WORKER_JWT: not a JWT');
  } else if (claims.role === 'service_role') {
    issues.push('SUPABASE_WORKER_JWT: service_role key refused (use the gateway_worker JWT)');
  } else if (claims.role !== WORKER_JWT_ROLE) {
    issues.push(`SUPABASE_WORKER_JWT: role claim must be ${WORKER_JWT_ROLE}`);
  } else if (typeof claims.exp === 'number' && claims.exp * 1000 <= nowMs) {
    issues.push('SUPABASE_WORKER_JWT: expired');
  }
  if (anonKey) {
    const a = decodeJwtPayload(anonKey);
    if (a?.role === 'service_role' || /^sb_secret_/.test(anonKey)) {
      issues.push('SUPABASE_ANON_KEY: a service-role/secret key is refused');
    }
  }
  return issues;
}

export function parseAllowlistSeed(raw: string): { numbers: string[]; invalid: number } {
  const numbers = new Set<string>();
  let invalid = 0;
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (!v) continue;
    const e = toE164(v);
    if (e.ok) numbers.add(e.value);
    else invalid += 1;
  }
  return { numbers: [...numbers], invalid };
}

/** Parse + validate the environment once. Throws `ConfigError` (fail fast) with safe messages. */
export function loadConfig(
  env: Record<string, string | undefined>,
  nowMs: number = Date.now(),
): WorkerConfig {
  const r = envSchema.safeParse(env);
  if (!r.success) {
    // Messages name the variable only; values (secrets, numbers) are never echoed.
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = r.data;
  const issues = checkWorkerJwt(e.SUPABASE_WORKER_JWT, e.SUPABASE_ANON_KEY, nowMs);

  if (!e.SESSION_KEY_FILE && !e.CREDENTIALS_DIRECTORY) {
    issues.push(
      'session key: set SESSION_KEY_FILE or run under systemd LoadCredential=session.key',
    );
  }
  const socketPath =
    e.TRANSCRIBER_SOCKET ??
    (e.XDG_RUNTIME_DIR ? path.join(e.XDG_RUNTIME_DIR, 'gateway-transcriber.sock') : undefined);
  if (!socketPath) issues.push('TRANSCRIBER_SOCKET: required when XDG_RUNTIME_DIR is unset');

  const seed = parseAllowlistSeed(e.LIA_ALLOWLIST_SEED);
  if (seed.invalid > 0) issues.push(`LIA_ALLOWLIST_SEED: ${seed.invalid} invalid number(s)`);

  if (issues.length) throw new ConfigError(issues);

  return {
    supabaseUrl: e.SUPABASE_URL,
    workerJwt: e.SUPABASE_WORKER_JWT,
    apiKey: e.SUPABASE_ANON_KEY ?? e.SUPABASE_WORKER_JWT,
    workerId: e.WORKER_ID,
    orgId: e.ORG_ID,
    sessionKey: { keyFile: e.SESSION_KEY_FILE, credentialsDirectory: e.CREDENTIALS_DIRECTORY },
    transcriber: { socketPath: socketPath!, timeoutMs: e.TRANSCRIBER_TIMEOUT_MS },
    soniox: e.SONIOX_ENABLED && e.SONIOX_API_KEY ? { apiKey: e.SONIOX_API_KEY } : null,
    sonioxMisconfigured: e.SONIOX_ENABLED && !e.SONIOX_API_KEY,
    liaAllowlistSeed: seed.numbers,
    storageBucket: e.STORAGE_BUCKET,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    logLevel: e.LOG_LEVEL,
    logShipLevel: e.LOG_SHIP_LEVEL,
    version: e.WORKER_VERSION ?? '0.1.0',
  };
}
