import { err, gatewayError, ok, type Result } from '@htz/core';
import type { Db } from './supabase';

export const MEDIA_BUCKET = 'media';
/** Signed URLs are short-lived (ARCH §7.1, S9): ≤ 15 minutes. */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

/** Paths that are not Storage objects (Graph media ids, external links). */
export function isStoragePath(path: string): boolean {
  return !/^(graph-media:|https?:\/\/)/i.test(path) && !path.includes('..') && path.length > 0;
}

export async function signedMediaUrl(
  db: Db,
  path: string,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<Result<string>> {
  if (!isStoragePath(path)) return err(gatewayError('invalid_input', 'not_a_storage_path'));
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), SIGNED_URL_TTL_SECONDS);
  try {
    const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(path, ttl);
    if (error || !data?.signedUrl) return err(gatewayError('not_found', 'media_unavailable'));
    return ok(data.signedUrl);
  } catch {
    return err(gatewayError('internal', 'media_sign_failed', { transient: true }));
  }
}
