-- Scheduled jobs (ARCH §4.1, §8.3; TEST-PLAN R4.8, RL5). Supabase pg_cron every minute,
-- calling Edge Functions through pg_net. No Vercel Cron (Hobby is daily-only).
--
-- Vault secrets read at call time (create them once per project, see docs/database.md):
--   edge_base_url     e.g. https://<project-ref>.supabase.co/functions/v1
--   edge_cron_secret  shared secret; the Edge Functions compare it with env EDGE_CRON_SECRET

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end
$$;

-- POST to an Edge Function. Returns the pg_net request id, or null when not configured.
create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text;
  v_secret text;
  v_id bigint;
begin
  if p_name !~ '^[a-z0-9-]+$' then
    raise exception 'invalid function name %', p_name using errcode = '22023';
  end if;
  select s.decrypted_secret into v_base from vault.decrypted_secrets s where s.name = 'edge_base_url';
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = 'edge_cron_secret';
  if v_base is null or v_secret is null then
    raise notice 'invoke_edge_function(%): vault secrets edge_base_url / edge_cron_secret missing', p_name;
    return null;
  end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise notice 'invoke_edge_function(%): pg_net not installed', p_name;
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_id
    using rtrim(v_base, '/') || '/' || p_name, coalesce(p_body, '{}'::jsonb),
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret), 10000;
  return v_id;
end
$$;

-- Due-work probes (avoid invoking functions with nothing to do).
create or replace function public.edge_jobs_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.outbound_queue q
    where q.executor = 'edge'
      and ((q.state = 'ready' and q.run_at <= now()) or (q.state = 'leased' and q.lease_until < now())))
$$;

create or replace function public.deliveries_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.webhook_deliveries d
                 where d.status in ('pending', 'failed') and d.next_attempt_at <= now()
                   and (d.lease_until is null or d.lease_until < now()))
      or exists (select 1 from public.relay_batches b
                 where b.status is null and b.next_attempt_at <= now()
                   and (b.lease_until is null or b.lease_until < now()))
$$;

-- Low-latency kick on new relay batches / webhook deliveries (ARCH §4.7 "DB trigger (pg_net)").
-- Best effort; the 1-minute sweep is the safety net.
create or replace function public.kick_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.invoke_edge_function('deliver-webhooks', jsonb_build_object('reason', 'insert:' || tg_table_name));
  exception when others then
    raise warning 'kick_deliveries failed: %', sqlerrm;
  end;
  return null;
end
$$;

create trigger relay_batches_kick after insert on public.relay_batches
  for each statement execute function public.kick_deliveries();
create trigger webhook_deliveries_kick after insert on public.webhook_deliveries
  for each statement execute function public.kick_deliveries();

do $$
declare
  j record;
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed; schedules skipped';
    return;
  end if;
  for j in
    select * from (values
      ('gw-heartbeat-check', '* * * * *', $c$select public.invoke_edge_function('heartbeat-alert')$c$),
      ('gw-cloud-retry', '* * * * *',
        $c$select public.invoke_edge_function('cloud-retry') where public.edge_jobs_due()$c$),
      ('gw-deliver-webhooks', '* * * * *',
        $c$select public.invoke_edge_function('deliver-webhooks') where public.deliveries_due()$c$),
      ('gw-relay-no-reply', '* * * * *', $c$select public.relay_evaluate_no_reply()$c$),
      ('gw-pairing-purge', '* * * * *', $c$select public.pairing_purge_expired()$c$),
      ('gw-retention', '17 2 * * *', $c$select public.retention_run()$c$)
    ) as v (name, sched, cmd)
  loop
    perform cron.unschedule(c.jobid) from cron.job c where c.jobname = j.name;
    perform cron.schedule(j.name, j.sched, j.cmd);
  end loop;
end
$$;
