-- Worker-callable relay RPCs (TEST-PLAN L4.6, L3.4). The worker owns two relay facts the
-- service_role-only RPCs could not record:
--   1. Lia's reply to a batch failed to reach Tzvi (job dead)  -> worker_relay_delivery_failed
--   2. A voice transcript finished after its batch was posted  -> worker_relay_transcript_followup
-- (2) creates a `relay_followups` row that the deliverer (deliver-webhooks -> Vercel
-- /api/internal/deliver kind 'relay_followup') POSTs to the relay target, signed like batches:
--   {"event": "transcript", "batch_id": ..., "message_id": ..., "transcript": ...|null}

-- ---------------------------------------------------------------------------
-- Reply link: which outbound message answered a batch (set by relay_mark_replied).
-- ---------------------------------------------------------------------------
alter table public.relay_batches
  add column reply_message_id uuid references public.messages (id) on delete set null;
create index relay_batches_reply_message_idx on public.relay_batches (reply_message_id)
  where reply_message_id is not null;

drop function public.relay_mark_replied(uuid, timestamptz);
-- Lia replied to a batch (send_message with reply_to_id = batch). Late replies after
-- no_reply still count. Test batches verify the channel. p_message_id links the reply so the
-- worker can later report a failed delivery of exactly that reply (L4.6).
create or replace function public.relay_mark_replied(p_batch_id uuid, p_at timestamptz default null,
  p_message_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.relay_batches%rowtype;
  v_at timestamptz := coalesce(p_at, now());
begin
  if p_message_id is not null then
    update public.relay_batches set reply_message_id = coalesce(reply_message_id, p_message_id)
     where batch_id = p_batch_id;
  end if;
  update public.relay_batches
     set status = 'replied', first_response_at = coalesce(first_response_at, v_at),
         replied_at = coalesce(replied_at, v_at)
   where batch_id = p_batch_id and status in ('accepted', 'no_reply', 'unreachable')
  returning * into b;
  if not found then
    return false;
  end if;
  if b.is_test then
    update public.relay_targets set last_verified_at = v_at where id = b.relay_target_id;
  end if;
  update public.alerts set resolved_at = now()
   where kind = 'relay_no_reply' and ref_id = p_batch_id::text and resolved_at is null;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- L4.6: the worker could not deliver Lia's reply (job dead). Scoped to what the worker owns:
-- an outbound, failed message of a Baileys account that is linked as the reply of a batch.
-- ---------------------------------------------------------------------------
create or replace function public.worker_relay_delivery_failed(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
  v_n int;
begin
  select msg.* into m from public.messages msg
    join public.accounts a on a.id = msg.account_id
   where msg.id = p_message_id and msg.direction = 'out' and a.provider = 'baileys';
  if not found then
    raise exception 'outbound baileys message % not found', p_message_id using errcode = 'P0002';
  end if;
  if m.status <> 'failed' then
    raise exception 'message % is not failed (status %)', p_message_id, m.status using errcode = '55000';
  end if;
  update public.relay_batches
     set status = 'delivery_failed', first_response_at = coalesce(first_response_at, now())
   where reply_message_id = p_message_id and status in ('accepted', 'replied', 'no_reply');
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit_append(m.org_id, 'worker', null, 'relay.delivery_failed', 'message:' || m.id, null,
      jsonb_build_object('error_code', m.error_code));
  end if;
  return v_n > 0;
end
$$;

-- ---------------------------------------------------------------------------
-- L3.4: transcript follow-up deliveries to the relay target.
-- ---------------------------------------------------------------------------
create table public.relay_followups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  batch_id uuid not null references public.relay_batches (batch_id) on delete cascade,
  relay_target_id uuid not null references public.relay_targets (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  event text not null default 'transcript' check (event in ('transcript')),
  transcript text,                 -- null = transcription failed (L3.7); purged after 7 days
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'dead')),
  attempt int not null default 0,
  max_attempts int not null default 6,
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  response_code int,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (batch_id, message_id, event)
);
create index relay_followups_due_idx on public.relay_followups (next_attempt_at)
  where status in ('pending', 'failed');
alter table public.relay_followups enable row level security;
create policy relay_followups_select_member on public.relay_followups
  for select to authenticated using ((select public.is_member(org_id)));
revoke all on public.relay_followups from anon, authenticated, gateway_worker;
grant select (id, org_id, batch_id, relay_target_id, account_id, message_id, event, status, attempt,
  max_attempts, next_attempt_at, response_code, last_error, created_at, delivered_at)
  on public.relay_followups to authenticated;

-- Idempotent on (batch_id, message_id). The message must be part of the batch.
create or replace function public.worker_relay_transcript_followup(p_batch_id uuid, p_message_id uuid,
  p_transcript text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.relay_batches%rowtype;
  v_id uuid;
begin
  select * into b from public.relay_batches where batch_id = p_batch_id;
  if not found then
    raise exception 'batch % not found', p_batch_id using errcode = 'P0002';
  end if;
  if b.is_test or not (p_message_id = any (b.message_ids)) then
    raise exception 'message % is not part of batch %', p_message_id, p_batch_id using errcode = '22023';
  end if;
  insert into public.relay_followups (org_id, batch_id, relay_target_id, account_id, message_id, transcript)
  values (b.org_id, b.batch_id, b.relay_target_id, b.account_id, p_message_id, p_transcript)
  on conflict (batch_id, message_id, event) do nothing
  returning id into v_id;
  if v_id is null then
    select f.id into v_id from public.relay_followups f
     where f.batch_id = p_batch_id and f.message_id = p_message_id and f.event = 'transcript';
  end if;
  return v_id;
end
$$;

create trigger relay_followups_kick after insert on public.relay_followups
  for each statement execute function public.kick_deliveries();

-- Follow-up attempt result: 2xx delivered; else retry with the webhook backoff, then dead.
create or replace function public.relay_followup_delivery_result(p_id uuid, p_http_status int,
  p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.relay_followups%rowtype;
begin
  select * into f from public.relay_followups where id = p_id for update;
  if not found then
    raise exception 'followup % not found', p_id using errcode = 'P0002';
  end if;
  if f.status in ('delivered', 'dead') then
    return f.status;
  end if;
  if p_http_status between 200 and 299 then
    update public.relay_followups
       set status = 'delivered', attempt = f.attempt + 1, response_code = p_http_status, delivered_at = now(),
           lease_owner = null, lease_until = null, last_error = null
     where id = p_id;
    return 'delivered';
  end if;
  if f.attempt + 1 >= f.max_attempts or p_http_status in (401, 403, 410)
     or (p_http_status between 400 and 499 and p_http_status not in (408, 429)) then
    update public.relay_followups
       set status = 'dead', attempt = f.attempt + 1, response_code = p_http_status, last_error = p_error,
           lease_owner = null, lease_until = null
     where id = p_id;
    return 'dead';
  end if;
  update public.relay_followups
     set status = 'failed', attempt = f.attempt + 1, response_code = p_http_status, last_error = p_error,
         lease_owner = null, lease_until = null,
         next_attempt_at = now() + public.webhook_backoff(f.attempt + 1) * (0.8 + random() * 0.4)
   where id = p_id;
  return 'failed';
end
$$;

-- Daily: transcripts in follow-ups are message content (S11): drop finished rows after 7 days.
create or replace function public.relay_followups_purge(p_days int default 7)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  delete from public.relay_followups
   where created_at < now() - make_interval(days => p_days) and status in ('delivered', 'dead');
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- claim_deliveries / deliveries_due now include follow-ups (kind 'relay_followup', id = followup id).
create or replace function public.claim_deliveries(p_worker_id text, p_n int default 20)
returns table (kind text, id uuid, attempt int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id from public.webhook_deliveries d
    where d.status in ('pending', 'failed') and d.next_attempt_at <= now()
      and (d.lease_until is null or d.lease_until < now())
    order by d.next_attempt_at
    limit greatest(coalesce(p_n, 20), 0)
    for update skip locked
  ), upd as (
    update public.webhook_deliveries d
       set lease_owner = p_worker_id, lease_until = now() + interval '60 seconds'
      from due where d.id = due.id
    returning d.id, d.attempt
  )
  select 'webhook'::text, upd.id, upd.attempt from upd;

  return query
  with due as (
    select b.id from public.relay_batches b
    where b.status is null and b.next_attempt_at <= now()
      and (b.lease_until is null or b.lease_until < now())
    order by b.next_attempt_at
    limit greatest(coalesce(p_n, 20), 0)
    for update skip locked
  ), upd as (
    update public.relay_batches b
       set lease_owner = p_worker_id, lease_until = now() + interval '60 seconds'
      from due where b.id = due.id
    returning b.batch_id, b.attempts
  )
  select 'relay'::text, upd.batch_id, upd.attempts from upd;

  -- Follow-ups only after their batch reached the receiver (keeps order: batch first, L3.4).
  return query
  with due as (
    select f.id from public.relay_followups f
    join public.relay_batches b on b.batch_id = f.batch_id
    where f.status in ('pending', 'failed') and f.next_attempt_at <= now()
      and (f.lease_until is null or f.lease_until < now())
      and b.status is not null
    order by f.next_attempt_at
    limit greatest(coalesce(p_n, 20), 0)
    for update of f skip locked
  ), upd as (
    update public.relay_followups f
       set lease_owner = p_worker_id, lease_until = now() + interval '60 seconds'
      from due where f.id = due.id
    returning f.id, f.attempt
  )
  select 'relay_followup'::text, upd.id, upd.attempt from upd;
end
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
      or exists (select 1 from public.relay_followups f
                 join public.relay_batches b on b.batch_id = f.batch_id
                 where f.status in ('pending', 'failed') and f.next_attempt_at <= now()
                   and (f.lease_until is null or f.lease_until < now()) and b.status is not null)
$$;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed; schedules skipped';
    return;
  end if;
  perform cron.unschedule(c.jobid) from cron.job c where c.jobname = 'gw-relay-followups-purge';
  perform cron.schedule('gw-relay-followups-purge', '23 2 * * *', $c$select public.relay_followups_purge()$c$);
end
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.relay_mark_replied(uuid, timestamptz, uuid),
  public.worker_relay_delivery_failed(uuid),
  public.worker_relay_transcript_followup(uuid, uuid, text),
  public.relay_followup_delivery_result(uuid, int, text),
  public.relay_followups_purge(int)
from public, anon, authenticated, service_role, gateway_worker;

grant execute on function
  public.worker_relay_delivery_failed(uuid),
  public.worker_relay_transcript_followup(uuid, uuid, text)
to gateway_worker;

grant execute on function
  public.relay_mark_replied(uuid, timestamptz, uuid),
  public.relay_followup_delivery_result(uuid, int, text),
  public.relay_followups_purge(int)
to service_role;
