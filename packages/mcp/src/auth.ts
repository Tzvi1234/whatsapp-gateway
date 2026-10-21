import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { err, gatewayError, isScope, ok, type Result, type Scope } from '@htz/core';
import type { ApiKeyRecord, ApiKeyRepo } from './deps';

/**
 * API key format: `gw_<prefix>_<secret>`
 *  - prefix: 8 lowercase alphanumerics (stored in `api_clients.key_prefix`, shown in the UI)
 *  - secret: 32 random bytes, base64url (43 chars)
 *  - key_hash: lowercase hex SHA-256 of the FULL token string (utf8)
 *
 * Legacy WhatsApp-Automation agent tokens (assumption, documented in README): opaque strings
 * with no `gw_` prefix, stored as SHA-256 hex of the whole token. They are imported with
 * `key_prefix = null`, `legacy = true` and looked up by hash.
 */

const PREFIXED = /^gw_([a-z0-9]{8})_([A-Za-z0-9_-]{32,128})$/;
const LEGACY = /^[\x21-\x7e]{16,512}$/;

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Creates a new key. The plaintext is returned once; persist only `prefix` + `hash`. */
export function generateApiKey(): { token: string; prefix: string; hash: string } {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  let prefix = '';
  for (const b of bytes) prefix += alphabet[b % alphabet.length];
  const token = `gw_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: hashApiKey(token) };
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

export type TokenShape = { kind: 'prefixed'; prefix: string } | { kind: 'legacy' } | null;

export function tokenShape(token: string): TokenShape {
  const m = PREFIXED.exec(token);
  if (m) return { kind: 'prefixed', prefix: m[1]! };
  if (token.startsWith('gw_')) return null; // malformed new-style key: never try legacy
  return LEGACY.test(token) ? { kind: 'legacy' } : null;
}

const recordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  keyPrefix: z.string().nullable(),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(z.string()),
  accountIds: z.array(z.string().min(1)),
  conversationIds: z.array(z.string().min(1)).nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  legacy: z.boolean(),
});

export interface AuthContext {
  apiClientId: string;
  name: string;
  scopes: ReadonlySet<Scope>;
  accountIds: readonly string[];
  conversationIds: readonly string[] | null;
  legacy: boolean;
}

function hashEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

/**
 * Authenticates a bearer token. Fails closed: repository errors, thrown errors and
 * malformed rows all reject (L2.3). Returned errors never say which check failed
 * beyond a stable detail.
 */
export async function authenticate(
  repo: ApiKeyRepo,
  authorization: string | null | undefined,
  now: Date,
): Promise<Result<AuthContext>> {
  const deny = (detail: string) => err(gatewayError('unauthorized', detail, { transient: false }));
  const token = parseBearer(authorization);
  if (!token) return deny('missing_bearer');
  const shape = tokenShape(token);
  if (!shape) return deny('malformed_key');
  const hash = hashApiKey(token);

  let found: Result<ApiKeyRecord | null>;
  try {
    found =
      shape.kind === 'prefixed'
        ? await repo.findByPrefix(shape.prefix)
        : await repo.findLegacyByHash(hash);
  } catch {
    return err(gatewayError('internal', 'key_lookup_failed', { transient: true }));
  }
  if (!found.ok) return err(gatewayError('internal', 'key_lookup_failed', { transient: true }));
  if (!found.value) return deny('unknown_key');

  const parsed = recordSchema.safeParse(found.value);
  if (!parsed.success) return deny('malformed_key_record');
  const rec = parsed.data;

  if (!hashEquals(hash, rec.keyHash)) return deny('unknown_key');
  if (shape.kind === 'prefixed' && rec.keyPrefix !== shape.prefix) return deny('unknown_key');
  if (shape.kind === 'legacy' && !rec.legacy) return deny('unknown_key');
  if (rec.revokedAt !== null) return deny('revoked');
  if (rec.expiresAt !== null) {
    const exp = Date.parse(rec.expiresAt);
    if (!Number.isFinite(exp) || exp <= now.getTime()) return deny('expired');
  }
  if (rec.conversationIds !== null && rec.conversationIds.length === 0) {
    return deny('malformed_key_record');
  }
  if (rec.scopes.includes('relay') && rec.conversationIds === null) {
    return deny('malformed_key_record'); // relay keys must be conversation-bound (L2.2)
  }

  const scopes = new Set<Scope>();
  for (const s of rec.scopes) if (isScope(s)) scopes.add(s);
  return ok({
    apiClientId: rec.id,
    name: rec.name,
    scopes,
    accountIds: rec.accountIds,
    conversationIds: rec.conversationIds,
    legacy: rec.legacy,
  });
}
