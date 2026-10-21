import 'server-only';
import { err, ok, type Result } from '@htz/core';
import type { Db } from './supabase';
import { isUuid, query } from './db';
import { isStoragePath, signedMediaUrl, SIGNED_URL_TTL_SECONDS } from './media';

/**
 * "Play original" (TEST-PLAN S9): a ≤15-minute signed URL for a message's stored media.
 * The message is read with the caller's RLS-scoped client (member of its org, AAL2); only the
 * signing uses the service client, because dashboard users have no Storage policy at all.
 * After the retention purge (media_path cleared, object queued for deletion) → `media_purged`.
 */

export type MediaUrlError = 'not_found' | 'media_purged' | 'media_unavailable' | 'internal';

export interface MediaUrl {
  url: string;
  expiresInSeconds: number;
  mime: string | null;
}

interface Row {
  id: string;
  org_id: string;
  kind: string;
  media_path: string | null;
  media_mime: string | null;
}

const MEDIA_KINDS = new Set(['voice', 'audio', 'image', 'video', 'document', 'sticker', 'media']);

export async function mediaOriginalUrl(
  userDb: Db,
  signDb: Db,
  orgId: string,
  messageId: string,
): Promise<Result<MediaUrl, { code: MediaUrlError }>> {
  if (!isUuid(messageId)) return err({ code: 'not_found' });
  const r = await query<Row | null>(
    userDb
      .from('messages')
      .select('id, org_id, kind, media_path, media_mime')
      .eq('id', messageId)
      .maybeSingle(),
    'messages.media',
  );
  if (!r.ok) return err({ code: 'internal' });
  const m = r.value;
  if (!m || m.org_id !== orgId || !MEDIA_KINDS.has(m.kind)) return err({ code: 'not_found' });
  if (!m.media_path) return err({ code: 'media_purged' });
  if (!isStoragePath(m.media_path)) return err({ code: 'media_unavailable' }); // e.g. graph-media: not copied yet
  if (!m.media_path.startsWith(`${m.org_id}/`)) return err({ code: 'media_unavailable' });
  const s = await signedMediaUrl(signDb, m.media_path, SIGNED_URL_TTL_SECONDS);
  if (!s.ok) {
    // Object already removed by the purge consumer (or never uploaded).
    return err({ code: s.error.code === 'not_found' ? 'media_purged' : 'internal' });
  }
  return ok({ url: s.value, expiresInSeconds: SIGNED_URL_TTL_SECONDS, mime: m.media_mime });
}
