// deliver-webhooks: invoked every minute by pg_cron (job gw-deliver-webhooks) when deliveries
// are due, and kicked right after inserts into relay_batches / webhook_deliveries (ARCH §4.7).
// Claims due relay batches (agent relay, e.g. Lia) and generic webhook deliveries and hands
// each to Vercel (/api/internal/deliver), which signs (HMAC t=,v1=), applies the outbound URL
// guard, POSTs, and records the result via relay_batch_delivery_result / webhook_delivery_result.
// If Vercel is unreachable nothing is recorded: the 60 s lease expires and the item is
// re-claimed without burning a receiver attempt.
//
// Env: EDGE_CRON_SECRET, PUBLIC_BASE_URL, INTERNAL_API_SECRET.
import { isAuthorizedCron, json, mapLimit, postInternal, rpc } from '../_shared/runtime.ts';

interface ClaimedDelivery {
  kind: 'relay' | 'webhook';
  id: string; // relay: batch_id; webhook: webhook_deliveries.id
  attempt: number;
}

const WORKER_ID = 'edge:deliver-webhooks';
const BATCH = 20;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!isAuthorizedCron(req)) return json({ error: 'unauthorized' }, 401);

  try {
    const items = await rpc<ClaimedDelivery[]>('claim_deliveries', {
      p_worker_id: WORKER_ID,
      p_n: BATCH,
    });
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const res = await postInternal('/api/internal/deliver', item);
        return { ...item, handed_off: res.ok, status: res.status };
      } catch (e) {
        return { ...item, handed_off: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    const failed = results.filter((r) => !r.handed_off);
    if (failed.length > 0) {
      console.error(
        JSON.stringify({ msg: 'deliver-webhooks hand-off failed', count: failed.length }),
      );
    }
    return json({ ok: true, claimed: items.length, results });
  } catch (e) {
    console.error(
      JSON.stringify({
        msg: 'deliver-webhooks failed',
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return json({ ok: false }, 500);
  }
});
