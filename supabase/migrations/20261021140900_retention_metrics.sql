-- Retention (ARCH §7.7; TEST-PLAN S11, L6.4) and metrics views (ARCH §5, §8.4).

-- ---------------------------------------------------------------------------
-- Retention. Defaults: bodies + transcripts 90d, media 30d, raw webhook payloads 7d,
-- worker logs/heartbeats 7d. audit_log is NEVER touched.
-- Media files are queued in media_purge_queue for deletion through the Storage API.
-- ---------------------------------------------------------------------------
create or replace function public.pairing_purge_expired()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
  v_m int;
begin
  delete from public.pairing_qr where expires_at < now();
  get diagnostics v_n = row_count;
  update public.pairing_requests set state = 'expired', completed_at = now()
   where state in ('pending', 'active') and expires_at < now();
  delete from public.pairing_requests where expires_at < now() - interval '1 day';
  get diagnostics v_m = row_count;
  return v_n + v_m;
end
$$;

create or replace function public.retention_run(
  p_body_days int default 90,
  p_media_days int default 30,
  p_raw_days int default 7,
  p_log_days int default 7)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bodies int; v_media int; v_raw int; v_logs int; v_hb int; v_wh int; v_login int; v_rl int; v_pair int;
begin
  -- Message bodies + transcripts (incl. blocked/unknown-sender rows).
  update public.messages
     set body = null, transcript = null
   where created_at < now() - make_interval(days => p_body_days)
     and (body is not null or transcript is not null);
  get diagnostics v_bodies = row_count;

  -- Media: queue storage objects for deletion, drop references.
  with old as (
    select m.id, m.org_id, m.media_path from public.messages m
    where m.created_at < now() - make_interval(days => p_media_days) and m.media_path is not null
  ), q as (
    insert into public.media_purge_queue (org_id, path)
    select old.org_id, old.media_path from old
    on conflict (bucket, path) do nothing
  )
  update public.messages m set media_path = null from old where m.id = old.id;
  get diagnostics v_media = row_count;

  update public.statuses set media_path = null
   where posted_at < now() - make_interval(days => p_media_days) and media_path is not null;

  update public.inbound_events set raw = null
   where received_at < now() - make_interval(days => p_raw_days) and raw is not null;
  get diagnostics v_raw = row_count;

  update public.webhook_deliveries set payload = null
   where created_at < now() - make_interval(days => p_raw_days) and payload is not null
     and status in ('delivered', 'dead');
  get diagnostics v_wh = row_count;

  delete from public.worker_logs where at < now() - make_interval(days => p_log_days);
  get diagnostics v_logs = row_count;

  delete from public.worker_heartbeats where at < now() - make_interval(days => p_log_days);
  get diagnostics v_hb = row_count;

  delete from public.login_attempts where at < now() - interval '30 days';
  get diagnostics v_login = row_count;

  delete from public.rate_limit_buckets where updated_at < now() - interval '1 day';
  get diagnostics v_rl = row_count;

  v_pair := public.pairing_purge_expired();

  return jsonb_build_object('bodies', v_bodies, 'media', v_media, 'inbound_raw', v_raw, 'webhook_payloads', v_wh,
    'worker_logs', v_logs, 'worker_heartbeats', v_hb, 'login_attempts', v_login, 'rate_limit_buckets', v_rl,
    'pairing', v_pair, 'ran_at', now());
end
$$;

-- ---------------------------------------------------------------------------
-- Metrics views. security_invoker so RLS of the querying user applies.
-- ---------------------------------------------------------------------------

-- Voice received -> transcript ready, bucketed by audio length.
create or replace view public.v_transcript_latency with (security_invoker = true) as
select m.org_id, m.account_id,
  case
    when m.media_seconds < 15 then '0-15s'
    when m.media_seconds < 30 then '15-30s'
    when m.media_seconds <= 60 then '30-60s'
    when m.media_seconds <= 120 then '60-120s'
    else '120s+'
  end as length_bucket,
  count(*) as n,
  percentile_cont(0.5) within group (order by extract(epoch from (m.transcript_ready_at - coalesce(m.received_at, m.created_at)))) as p50_s,
  percentile_cont(0.9) within group (order by extract(epoch from (m.transcript_ready_at - coalesce(m.received_at, m.created_at)))) as p90_s
from public.messages m
where m.direction = 'in' and m.kind in ('voice', 'audio') and m.transcript_ready_at is not null
  and m.media_seconds is not null
group by 1, 2, 3;

-- Failed outbound rate per provider, last 24h and 7d.
create or replace view public.v_failed_rate_by_provider with (security_invoker = true) as
select m.org_id, a.provider, w.window_name,
  count(*) as total,
  count(*) filter (where m.status = 'failed') as failed,
  round(coalesce((count(*) filter (where m.status = 'failed'))::numeric / nullif(count(*), 0), 0), 4) as failed_rate
from public.messages m
join public.accounts a on a.id = m.account_id
cross join (values ('24h', interval '24 hours'), ('7d', interval '7 days')) as w (window_name, span)
where m.direction = 'out' and m.created_at > now() - w.span
group by 1, 2, 3;

-- Baileys session lifetime: each `open` until the next close-like event.
create or replace view public.v_session_lifetime with (security_invoker = true) as
select e.org_id, e.account_id, e.at as opened_at, e.next_at as closed_at, e.next_event as closed_by,
  extract(epoch from (e.next_at - e.at)) as lifetime_s
from (
  select se.*, lead(se.at) over w as next_at, lead(se.event) over w as next_event
  from public.session_events se
  where se.event in ('open', 'paired', 'relinked', 'restored', 'close', 'conflict', 'needs_relink', 'logged_out')
  window w as (partition by se.account_id order by se.at)
) e
where e.event in ('open', 'paired', 'relinked', 'restored')
  and e.next_event in ('close', 'conflict', 'needs_relink', 'logged_out');

-- Reconnect time: each `close` until the next open-like event.
create or replace view public.v_reconnect_time with (security_invoker = true) as
select e.org_id, e.account_id, e.at as closed_at, e.next_at as reopened_at,
  extract(epoch from (e.next_at - e.at)) as reconnect_s
from (
  select se.*, lead(se.at) over w as next_at, lead(se.event) over w as next_event
  from public.session_events se
  where se.event in ('open', 'paired', 'relinked', 'restored', 'close')
  window w as (partition by se.account_id order by se.at)
) e
where e.event = 'close' and e.next_event in ('open', 'paired', 'relinked', 'restored');

-- MCP/webhook request -> sent_at, per day and provider.
create or replace view public.v_send_latency with (security_invoker = true) as
select m.org_id, a.provider, m.account_id, date_trunc('day', m.sent_at) as day,
  count(*) as n,
  percentile_cont(0.5) within group (order by extract(epoch from (m.sent_at - coalesce(m.requested_at, m.created_at))) * 1000) as p50_ms,
  percentile_cont(0.95) within group (order by extract(epoch from (m.sent_at - coalesce(m.requested_at, m.created_at))) * 1000) as p95_ms
from public.messages m
join public.accounts a on a.id = m.account_id
where m.direction = 'out' and m.sent_at is not null and m.received_at is null
group by 1, 2, 3, 4;

-- User's first message in a batch -> agent's first reply.
create or replace view public.v_relay_first_response with (security_invoker = true) as
select b.org_id, b.relay_target_id, date_trunc('day', b.created_at) as day,
  count(*) as n,
  percentile_cont(0.5) within group (order by extract(epoch from (b.first_response_at - coalesce(b.first_message_at, b.created_at))) * 1000) as p50_ms,
  percentile_cont(0.95) within group (order by extract(epoch from (b.first_response_at - coalesce(b.first_message_at, b.created_at))) * 1000) as p95_ms
from public.relay_batches b
where b.first_response_at is not null and not b.is_test
group by 1, 2, 3;

create or replace view public.v_relay_no_reply_rate with (security_invoker = true) as
select b.org_id, b.relay_target_id, date_trunc('day', b.created_at) as day,
  count(*) filter (where b.status is not null) as delivered_or_final,
  count(*) filter (where b.status = 'no_reply') as no_reply,
  round(coalesce((count(*) filter (where b.status = 'no_reply'))::numeric
    / nullif(count(*) filter (where b.status in ('accepted', 'replied', 'no_reply', 'delivery_failed')), 0), 0), 4)
    as no_reply_rate
from public.relay_batches b
where not b.is_test
group by 1, 2, 3;

-- Account created -> first paired/open -> first outbound sent.
create or replace view public.v_first_connect_funnel with (security_invoker = true) as
select a.org_id, a.id as account_id, a.provider, a.created_at,
  p.first_connected_at,
  s.first_sent_at,
  extract(epoch from (p.first_connected_at - a.created_at)) as to_connect_s,
  extract(epoch from (s.first_sent_at - a.created_at)) as to_first_message_s
from public.accounts a
left join lateral (
  select min(se.at) as first_connected_at from public.session_events se
  where se.account_id = a.id and se.event in ('paired', 'open')
) p on true
left join lateral (
  select min(m.sent_at) as first_sent_at from public.messages m
  where m.account_id = a.id and m.direction = 'out' and m.sent_at is not null
) s on true;

grant select on public.v_transcript_latency, public.v_failed_rate_by_provider, public.v_session_lifetime,
  public.v_reconnect_time, public.v_send_latency, public.v_relay_first_response, public.v_relay_no_reply_rate,
  public.v_first_connect_funnel to authenticated, service_role;
revoke all on public.v_transcript_latency, public.v_failed_rate_by_provider, public.v_session_lifetime,
  public.v_reconnect_time, public.v_send_latency, public.v_relay_first_response, public.v_relay_no_reply_rate,
  public.v_first_connect_funnel from anon;
