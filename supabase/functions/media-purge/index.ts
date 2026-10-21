// media-purge: invoked by pg_cron (job gw-media-purge, every 10 minutes) when media_purge_queue
// has open rows (retention, ARCH §7.7, TEST-PLAN S11 / S9). Claims queued Storage objects and
// deletes them through the Storage API (a direct DELETE on storage.objects would orphan the files),
// then acks them with media_purge_ack. Objects that are already gone count as purged. On a Storage
// error the batch is released with the error and retried on a later run (max 10 attempts).
//
// Env: EDGE_CRON_SECRET (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected).
import { isAuthorizedCron, json, requireEnv, rpc } from '../_shared/runtime.ts';

interface Claimed {
  id: string;
  bucket: string;
  path: string;
}

const BATCH = 200;
const CHUNK = 100; // Storage API remove() takes a list of prefixes; keep requests small

async function removeObjects(bucket: string, paths: string[]): Promise<void> {
  const url = `${requireEnv('SUPABASE_URL')}/storage/v1/object/${encodeURIComponent(bucket)}`;
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`storage_remove_http_${res.status}`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!isAuthorizedCron(req)) return json({ error: 'unauthorized' }, 401);

  try {
    const items = await rpc<Claimed[]>('media_purge_claim', { p_n: BATCH });
    const byBucket = new Map<string, Claimed[]>();
    for (const it of items) byBucket.set(it.bucket, [...(byBucket.get(it.bucket) ?? []), it]);
    let purged = 0;
    let failed = 0;
    for (const [bucket, rows] of byBucket) {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const ids = chunk.map((r) => r.id);
        try {
          await removeObjects(
            bucket,
            chunk.map((r) => r.path),
          );
          purged += await rpc<number>('media_purge_ack', { p_ids: ids });
        } catch (e) {
          failed += chunk.length;
          await rpc('media_purge_ack', {
            p_ids: ids,
            p_error: e instanceof Error ? e.message : 'error',
          }).catch(() => undefined);
        }
      }
    }
    // Paths are not logged (they contain message ids); counts only.
    return json({ ok: true, claimed: items.length, purged, failed });
  } catch (e) {
    console.error(
      JSON.stringify({
        msg: 'media-purge failed',
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return json({ ok: false }, 500);
  }
});
