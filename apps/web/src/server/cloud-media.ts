import 'server-only';
import { createHash } from 'node:crypto';
import { err, gatewayError, ok, type Result } from '@htz/core';
import { GRAPH_BASE_URL, GRAPH_VERSION } from '@htz/provider-cloud';
import type { Db } from './supabase';
import { query } from './db';
import { readCloudCredentials } from './cloud';
import { MEDIA_BUCKET } from './media';
import { logWarn } from './log';

/**
 * Cloud API inbound media → private Storage bucket (ARCH §4.3/§7.1, TEST-PLAN S9).
 * `/api/meta/webhook` stores `graph-media:<id>` and answers Meta at once; the copy happens later,
 * in the deliver step, when a relay payload needs a signed `media_url`:
 * Graph `GET /{media-id}` → short-lived download URL → download with the account token (size cap,
 * timeouts, Meta CDN hosts only so the token never leaves Meta) → Storage
 * `<org>/<account>/<provider_message_id>` → `messages.media_path` updated (compare-and-set).
 */

export const GRAPH_MEDIA_PREFIX = 'graph-media:';
/** WhatsApp caps audio/video/images at 16 MB; documents can be larger than a function should hold. */
export const MAX_CLOUD_MEDIA_BYTES = 25 * 1024 * 1024;
export const CLOUD_MEDIA_TIMEOUT_MS = 10_000;
const META_MEDIA_HOSTS = ['.fbsbx.com', '.facebook.com', '.fbcdn.net', '.whatsapp.net'];

export interface CloudMediaMessage {
  id: string;
  org_id: string;
  account_id: string;
  provider_message_id: string | null;
  media_path: string;
  media_mime: string | null;
}

export interface CloudMediaOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export function isGraphMediaPath(p: string | null | undefined): p is string {
  return typeof p === 'string' && p.startsWith(GRAPH_MEDIA_PREFIX);
}

/** Same object naming as the worker (`mediaObjectPath`): unsafe ids are hashed. */
export function cloudMediaObjectPath(orgId: string, accountId: string, providerId: string): string {
  const id = /^[A-Za-z0-9_-]{1,128}$/.test(providerId)
    ? providerId
    : createHash('sha256').update(providerId).digest('hex').slice(0, 40);
  return `${orgId}/${accountId}/${id}`;
}

function isMetaMediaUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && META_MEDIA_HOSTS.some((h) => host.endsWith(h));
  } catch {
    return false;
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const fail = (code: Parameters<typeof gatewayError>[0], detail: string, transient: boolean) =>
  err(gatewayError(code, detail, { transient }));

export async function materializeCloudMedia(
  db: Db,
  m: CloudMediaMessage,
  opts: CloudMediaOptions = {},
): Promise<Result<string>> {
  if (!isGraphMediaPath(m.media_path)) return ok(m.media_path);
  const mediaId = m.media_path.slice(GRAPH_MEDIA_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) return fail('invalid_input', 'bad_media_id', false);
  if (!m.provider_message_id) return fail('invalid_input', 'no_provider_id', false);
  const f = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? CLOUD_MEDIA_TIMEOUT_MS;
  const max = opts.maxBytes ?? MAX_CLOUD_MEDIA_BYTES;

  const c = await readCloudCredentials(db, m.account_id);
  if (!c.ok) return c;
  const token = c.value?.accessToken;
  if (!token) return fail('provider_unconfigured', 'cloud_token_missing', false);
  const auth = { Authorization: `Bearer ${token}` };

  let meta: { url?: unknown; mime_type?: unknown; file_size?: unknown };
  try {
    const r = await f(`${GRAPH_BASE_URL}/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, {
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      await r.body?.cancel();
      return fail('provider_error', `graph_media_${r.status}`, r.status >= 500 || r.status === 429);
    }
    meta = (await r.json()) as typeof meta;
  } catch {
    return fail('network', 'graph_media_lookup', true);
  }
  if (typeof meta.file_size === 'number' && meta.file_size > max) {
    return fail('media_too_large', 'cloud_media_over_cap', false);
  }
  if (!isMetaMediaUrl(meta.url)) return fail('provider_error', 'graph_media_url_untrusted', false);

  let bytes: Uint8Array | null;
  try {
    const r = await f(meta.url, {
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      await r.body?.cancel();
      return fail('provider_error', `graph_media_download_${r.status}`, r.status >= 500);
    }
    bytes = await readCapped(r, max);
  } catch {
    return fail('network', 'graph_media_download', true);
  }
  if (!bytes) return fail('media_too_large', 'cloud_media_over_cap', false);

  const mime =
    (typeof meta.mime_type === 'string' ? meta.mime_type : null) ??
    m.media_mime ??
    'application/octet-stream';
  const path = cloudMediaObjectPath(m.org_id, m.account_id, m.provider_message_id);
  try {
    const { error } = await db.storage
      .from(MEDIA_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (error) return fail('internal', 'storage_upload_failed', true);
  } catch {
    return fail('internal', 'storage_upload_failed', true);
  }
  const u = await query(
    db
      .from('messages')
      .update({ media_path: path, media_mime: m.media_mime ?? mime })
      .eq('id', m.id)
      .eq('media_path', m.media_path),
    'messages.cloud_media',
  );
  if (!u.ok) logWarn('cloud_media_path_update_failed', { code: u.error.code });
  return ok(path);
}
