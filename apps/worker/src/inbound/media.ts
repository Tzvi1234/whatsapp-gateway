/**
 * Inbound media → private Storage bucket (ARCH §4.4, §7.1). Path `<org>/<account>/<message_id>`
 * where message_id is the provider message id (known before `ingest_inbound`, unique per account).
 * The bucket is private; consumers get ≤15-min signed URLs from the server side only.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface MediaStore {
  /** Idempotent: an existing object at `path` counts as success (re-delivered message). */
  upload(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  download(path: string): Promise<Uint8Array>;
}

export function mediaObjectPath(
  orgId: string,
  accountId: string,
  providerMessageId: string,
): string {
  const id = /^[A-Za-z0-9_-]{1,128}$/.test(providerMessageId)
    ? providerMessageId
    : createHash('sha256').update(providerMessageId).digest('hex').slice(0, 40);
  return `${orgId}/${accountId}/${id}`;
}

export function supabaseMediaStore(client: SupabaseClient, bucket: string): MediaStore {
  return {
    async upload(path, bytes, mime) {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
          contentType: mime,
          upsert: false,
        });
      if (error) {
        const status = (error as { statusCode?: string | number }).statusCode;
        if (String(status) === '409' || /exists/i.test(error.message)) return;
        throw new Error(`storage_upload_failed:${String(status ?? 'error')}`);
      }
    },
    async download(path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) throw new Error('storage_download_failed');
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
