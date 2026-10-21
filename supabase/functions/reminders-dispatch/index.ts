// reminders-dispatch: invoked every minute by pg_cron (job gw-reminders → reminders_dispatch_due())
// when reminders are due (TEST-PLAN R4.1-R4.6, R4.8). Claims due reminders (state → sending,
// 60 s lease) and hands each one to Vercel (/api/internal/reminders), which runs THE send gate
// (`reminders.dispatch`), enqueues with idempotency key `reminder:<id>`, sends (Cloud) or queues
// for the worker (Baileys) and records the outcome with reminder_record_dispatch. Nothing is sent
// from here. If Vercel cannot be reached nothing is recorded: the lease expires and the reminder
// is re-claimed on a later run (the enqueue is idempotent).
//
// Env: EDGE_CRON_SECRET, PUBLIC_BASE_URL, INTERNAL_API_SECRET.
import { isAuthorizedCron, json, mapLimit, postInternal, rpc } from '../_shared/runtime.ts';

interface ClaimedReminder {
  reminder_id: string;
  account_id: string;
  attempts: number;
  lease_until: string;
}

const WORKER_ID = 'edge:reminders-dispatch';
const BATCH = 20;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!isAuthorizedCron(req)) return json({ error: 'unauthorized' }, 401);

  try {
    const items = await rpc<ClaimedReminder[]>('reminders_claim_due', {
      p_worker_id: WORKER_ID,
      p_n: BATCH,
    });
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const res = await postInternal('/api/internal/reminders', {
          reminder_id: item.reminder_id,
          lease_until: item.lease_until,
        });
        return { reminder_id: item.reminder_id, handed_off: res.ok, status: res.status };
      } catch (e) {
        return {
          reminder_id: item.reminder_id,
          handed_off: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });
    const failed = results.filter((r) => !r.handed_off);
    if (failed.length > 0) {
      console.error(
        JSON.stringify({ msg: 'reminders-dispatch hand-off failed', count: failed.length }),
      );
    }
    return json({ ok: true, claimed: items.length, results });
  } catch (e) {
    console.error(
      JSON.stringify({
        msg: 'reminders-dispatch failed',
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return json({ ok: false }, 500);
  }
});
