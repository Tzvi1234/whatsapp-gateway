// heartbeat-alert: invoked every minute by pg_cron (job gw-heartbeat-check) via pg_net.
// Stale worker (>3 min) -> exactly one "down" e-mail; recovery -> exactly one "recovered"
// e-mail with the downtime duration (ARCH §8.3, TEST-PLAN RL5). Independent of Vercel and
// htz-home-01. Dry-run (log only) when ALERT_EMAIL_API_KEY / ALERT_EMAIL_TO / ALERT_EMAIL_FROM
// are not set.
//
// Env: EDGE_CRON_SECRET, ALERT_EMAIL_API_KEY, ALERT_EMAIL_TO (comma-separated),
//      ALERT_EMAIL_FROM, optional ALERT_EMAIL_API_URL (Resend-compatible, default api.resend.com).
import { env, isAuthorizedCron, json, rpc } from '../_shared/runtime.ts';
import {
  buildEmail,
  emailConfigFrom,
  emailRequestBody,
  type HeartbeatNotification,
} from '../_shared/heartbeat.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!isAuthorizedCron(req)) return json({ error: 'unauthorized' }, 401);

  try {
    // 1. Transition stale workers to "down" (idempotent, transactional in Postgres).
    const opened = await rpc<unknown[]>('heartbeat_evaluate', {});

    // 2. Claim owed mails (leased, so a concurrent run cannot send them too).
    const owed = await rpc<HeartbeatNotification[]>('heartbeat_claim_notifications', {
      p_lease_seconds: 120,
    });

    const cfg = emailConfigFrom(env);
    const results: {
      interval_id: string;
      kind: string;
      sent: boolean;
      dry_run: boolean;
      error?: string;
    }[] = [];

    for (const n of owed) {
      const email = buildEmail(n);
      if (cfg === null) {
        console.log(
          JSON.stringify({
            msg: 'heartbeat-alert dry-run',
            kind: n.kind,
            worker_id: n.worker_id,
            subject: email.subject,
          }),
        );
        // Ack in dry-run too, so enabling e-mail later does not flush old outages.
        await rpc('heartbeat_ack_notification', { p_interval_id: n.interval_id, p_kind: n.kind });
        results.push({ interval_id: n.interval_id, kind: n.kind, sent: false, dry_run: true });
        continue;
      }
      try {
        const res = await fetch(cfg.apiUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(emailRequestBody(cfg, email)),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`email API HTTP ${res.status}`);
        // Ack only after the provider accepted it; an un-acked claim is retried after the lease.
        await rpc('heartbeat_ack_notification', { p_interval_id: n.interval_id, p_kind: n.kind });
        results.push({ interval_id: n.interval_id, kind: n.kind, sent: true, dry_run: false });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            msg: 'heartbeat-alert send failed',
            kind: n.kind,
            worker_id: n.worker_id,
            error,
          }),
        );
        results.push({
          interval_id: n.interval_id,
          kind: n.kind,
          sent: false,
          dry_run: false,
          error,
        });
      }
    }
    return json({ ok: true, opened: opened.length, notifications: results });
  } catch (e) {
    console.error(
      JSON.stringify({
        msg: 'heartbeat-alert failed',
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return json({ ok: false }, 500);
  }
});
