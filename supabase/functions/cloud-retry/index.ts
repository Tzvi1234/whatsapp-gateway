// cloud-retry: invoked every minute by pg_cron (job gw-cloud-retry) when executor='edge'
// jobs are due (ARCH §4.1, §8.2, TEST-PLAN R4.5, R4.8). Claims Cloud API retry jobs and hands
// each one to Vercel (/api/internal/cloud-send), which re-runs the send gate (S13), performs
// the Graph call and then calls complete_job / fail_job itself. If Vercel cannot be reached, the job is failed as transient
// here so the normal backoff (5s, 30s, 2m, 10m, 15m) applies.
//
// Env: EDGE_CRON_SECRET, PUBLIC_BASE_URL, INTERNAL_API_SECRET.
import { isAuthorizedCron, json, mapLimit, postInternal, rpc } from '../_shared/runtime.ts';

interface ClaimedJob {
  job_id: string;
  message_id: string;
  account_id: string;
  conversation_id: string | null;
  chat_jid: string | null;
  attempts: number;
  lease_until: string;
  provider_message_id: string | null;
}

const WORKER_ID = 'edge:cloud-retry';
const BATCH = 20;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!isAuthorizedCron(req)) return json({ error: 'unauthorized' }, 401);

  try {
    const jobs = await rpc<ClaimedJob[]>('claim_jobs', {
      p_worker_id: WORKER_ID,
      p_executor: 'edge',
      p_n: BATCH,
    });
    const results = await mapLimit(jobs, 4, async (job) => {
      // Already sent (provider id recorded) -> complete, never resend (RL2).
      if (job.provider_message_id) {
        await rpc('complete_job', {
          p_job_id: job.job_id,
          p_provider_message_id: job.provider_message_id,
        });
        return { job_id: job.job_id, outcome: 'completed_existing' };
      }
      try {
        const res = await postInternal('/api/internal/cloud-send', {
          job_id: job.job_id,
          message_id: job.message_id,
          account_id: job.account_id,
          attempt: job.attempts,
          lease_until: job.lease_until,
        });
        if (res.ok) return { job_id: job.job_id, outcome: 'handed_off' };
        throw new Error(`cloud-send HTTP ${res.status}`);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        await rpc('fail_job', {
          p_job_id: job.job_id,
          p_error_code: 'network',
          p_transient: true,
          p_detail: detail,
        });
        return { job_id: job.job_id, outcome: 'retry_scheduled', detail };
      }
    });
    return json({ ok: true, claimed: jobs.length, results });
  } catch (e) {
    console.error(
      JSON.stringify({
        msg: 'cloud-retry failed',
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return json({ ok: false }, 500);
  }
});
