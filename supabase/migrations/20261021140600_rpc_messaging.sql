-- Messaging RPCs: enqueue, queue claim/lease/complete/fail, inbound ingest, status updates.
-- All security definer + `set search_path = ''`. EXECUTE grants live in *_function_grants.sql.
-- ARCH §4.1, §4.2, §4.4, §8.1, §8.2; TEST-PLAN RL1, RL2, RL3, R3.5, R4.5, R4.7.

-- ---------------------------------------------------------------------------
-- Internal helpers (not granted to any API role)
-- ---------------------------------------------------------------------------
create or replace function public.chat_type_of(p_chat_jid text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_chat_jid = 'status@broadcast' then 'status'
    when p_chat_jid like '%@g.us' then 'group'
    else 'direct'
  end
$$;

create or replace function public.ensure_conversation(p_org_id uuid, p_account_id uuid, p_chat_jid text,
  p_type text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id from public.conversations c
  where c.account_id = p_account_id and c.chat_jid = p_chat_jid;
  if v_id is null then
    insert into public.conversations (org_id, account_id, chat_jid, type)
    values (p_org_id, p_account_id, p_chat_jid, coalesce(p_type, public.chat_type_of(p_chat_jid)))
    on conflict (account_id, chat_jid) do nothing
    returning id into v_id;
    if v_id is null then
      select c.id into v_id from public.conversations c
      where c.account_id = p_account_id and c.chat_jid = p_chat_jid;
    end if;
  end if;
  return v_id;
end
$$;

-- Moves a job to the dead letter: job dead, message failed, P2 alert (ARCH §8.2/§8.3).
create or replace function public.queue_mark_dead(p_job_id uuid, p_error_code text, p_alert boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.outbound_queue%rowtype;
begin
  update public.outbound_queue q
     set state = 'dead', lease_owner = null, lease_until = null,
         last_error_code = coalesce(p_error_code, q.last_error_code)
   where q.id = p_job_id
  returning * into j;
  if not found then
    return;
  end if;
  update public.messages m
     set status = 'failed', failed_at = now(), error_code = coalesce(p_error_code, m.error_code)
   where m.id = j.message_id and m.status in ('queued', 'sending');
  if p_alert then
    insert into public.alerts (org_id, severity, kind, account_id, ref_id, message)
    values (j.org_id, 'P2', 'dead_letter', j.account_id, j.id::text,
            format('Message %s moved to dead letter after %s attempts (%s)', j.message_id, j.attempts,
                   coalesce(p_error_code, 'unknown')));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Generic webhook fan-out (message.received / message.status / session.changed)
-- ---------------------------------------------------------------------------
create or replace function public.webhook_enqueue_event(p_org_id uuid, p_account_id uuid, p_event text,
  p_payload jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  insert into public.webhook_deliveries (org_id, endpoint_id, event, payload)
  select e.org_id, e.id, p_event, p_payload
  from public.webhook_endpoints e
  where e.org_id = p_org_id and e.enabled and p_event = any (e.events)
    and (e.account_id is null or e.account_id = p_account_id);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- enqueue_message: idempotent on (api_client_id, idempotency_key) incl. concurrent duplicates.
-- p_executor: 'auto' (baileys -> worker job; meta_cloud -> no job, Vercel sends directly and
-- then calls message_record_send_result), 'worker', 'edge', or 'none'.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_message(
  p_account_id uuid,
  p_chat_jid text,
  p_kind text,
  p_body text default null,
  p_media_path text default null,
  p_media_mime text default null,
  p_template jsonb default null,
  p_quoted_provider_id text default null,
  p_use_case text default null,
  p_api_client_id uuid default null,
  p_idempotency_key text default null,
  p_created_by uuid default null,
  p_executor text default 'auto',
  p_requested_at timestamptz default null,
  p_prior_attempts int default 0,
  p_delivery_mode text default null)
returns table (message_id uuid, status text, created boolean, job_id uuid, conversation_id uuid,
  provider_message_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_conv uuid;
  v_msg uuid;
  v_job uuid;
  v_exec text;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;

  v_exec := case p_executor
    when 'auto' then case a.provider when 'baileys' then 'worker' else null end
    when 'none' then null
    else p_executor
  end;
  if v_exec is not null and v_exec not in ('worker', 'edge') then
    raise exception 'invalid executor %', p_executor using errcode = '22023';
  end if;
  if (v_exec = 'worker' and a.provider <> 'baileys') or (v_exec = 'edge' and a.provider <> 'meta_cloud') then
    raise exception 'executor % does not match provider %', v_exec, a.provider using errcode = '22023';
  end if;

  v_conv := public.ensure_conversation(a.org_id, a.id, p_chat_jid);

  insert into public.messages as m (org_id, account_id, conversation_id, direction, kind, body, media_path,
    media_mime, template, status, delivery_mode, quoted_provider_id, idempotency_key, api_client_id,
    created_by, use_case, from_me, requested_at)
  values (a.org_id, a.id, v_conv, 'out', p_kind, p_body, p_media_path, p_media_mime, p_template, 'queued',
    p_delivery_mode, p_quoted_provider_id, p_idempotency_key, p_api_client_id, p_created_by, p_use_case,
    true, coalesce(p_requested_at, now()))
  on conflict (api_client_id, idempotency_key) do nothing
  returning m.id into v_msg;

  if v_msg is null then
    -- Duplicate (sequential or concurrent: ON CONFLICT waited for the other tx to commit).
    return query
      select m.id, m.status, false, (select q.id from public.outbound_queue q where q.message_id = m.id
                                     order by q.created_at desc limit 1),
             m.conversation_id, m.provider_message_id
      from public.messages m
      where m.api_client_id = p_api_client_id and m.idempotency_key = p_idempotency_key;
    return;
  end if;

  update public.conversations c set last_message_at = now() where c.id = v_conv;

  if v_exec is not null then
    insert into public.outbound_queue (org_id, message_id, account_id, conversation_id, executor, run_at, attempts)
    values (a.org_id, v_msg, a.id, v_conv, v_exec,
            case when coalesce(p_prior_attempts, 0) > 0 then now() + public.queue_backoff(p_prior_attempts) else now() end,
            greatest(coalesce(p_prior_attempts, 0), 0))
    returning id into v_job;
  end if;

  return query select v_msg, 'queued'::text, true, v_job, v_conv, null::text;
end
$$;

-- Result of a direct (non-queued) Cloud API send performed on Vercel (ARCH §4.1).
-- Success -> sent. Transient error -> edge retry job (5s first). Permanent -> failed.
create or replace function public.message_record_send_result(
  p_message_id uuid,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_transient boolean default false,
  p_delivery_mode text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
begin
  select * into m from public.messages where id = p_message_id for update;
  if not found then
    raise exception 'message % not found', p_message_id using errcode = 'P0002';
  end if;

  if p_provider_message_id is not null then
    update public.messages
       set status = case when status in ('queued', 'sending') then 'sent' else status end,
           provider_message_id = coalesce(provider_message_id, p_provider_message_id),
           sent_at = coalesce(sent_at, now()),
           delivery_mode = coalesce(p_delivery_mode, delivery_mode),
           error_code = null
     where id = p_message_id;
    return 'sent';
  end if;

  if p_transient then
    if not exists (select 1 from public.outbound_queue q where q.message_id = p_message_id
                   and q.state in ('ready', 'leased')) then
      insert into public.outbound_queue (org_id, message_id, account_id, conversation_id, executor, run_at, attempts)
      values (m.org_id, m.id, m.account_id, m.conversation_id, 'edge', now() + public.queue_backoff(1), 1);
    end if;
    update public.messages set status = 'queued', error_code = p_error_code where id = p_message_id;
    return 'queued';
  end if;

  update public.messages
     set status = 'failed', failed_at = now(), error_code = p_error_code
   where id = p_message_id and status in ('queued', 'sending');
  return 'failed';
end
$$;

-- Resend from the dashboard / MCP resend_message: new attempt, same message (idempotency lineage).
create or replace function public.message_requeue(p_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
  a public.accounts%rowtype;
  v_job uuid;
begin
  select * into m from public.messages where id = p_message_id for update;
  if not found or m.direction <> 'out' then
    raise exception 'outbound message % not found', p_message_id using errcode = 'P0002';
  end if;
  if m.status not in ('failed', 'cancelled') or m.provider_message_id is not null then
    raise exception 'message % is not resendable (status %)', p_message_id, m.status using errcode = '55000';
  end if;
  select * into a from public.accounts where id = m.account_id;
  update public.messages set status = 'queued', error_code = null, failed_at = null where id = m.id;
  insert into public.outbound_queue (org_id, message_id, account_id, conversation_id, executor)
  values (m.org_id, m.id, m.account_id, m.conversation_id,
          case a.provider when 'baileys' then 'worker' else 'edge' end)
  returning id into v_job;
  return v_job;
end
$$;

-- ---------------------------------------------------------------------------
-- Queue: claim / renew / complete / fail
-- ---------------------------------------------------------------------------
create or replace function public.claim_jobs(p_worker_id text, p_executor text, p_n int default 10)
returns table (
  job_id uuid, message_id uuid, account_id uuid, conversation_id uuid, chat_jid text, attempts int,
  lease_until timestamptz, kind text, body text, media_path text, media_mime text, template jsonb,
  quoted_provider_id text, provider_message_id text, idempotency_key text, use_case text,
  delivery_mode text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_ids uuid[];
begin
  if p_executor is null or p_executor not in ('worker', 'edge') then
    raise exception 'invalid executor %', p_executor using errcode = '22023';
  end if;
  if coalesce(p_worker_id, '') = '' then
    raise exception 'worker_id required' using errcode = '22023';
  end if;

  -- 1. Reclaim expired leases (crashed / stalled claimers). Exhausted -> dead letter.
  for r in
    update public.outbound_queue q
       set state = 'ready', lease_owner = null, lease_until = null,
           last_error_code = coalesce(q.last_error_code, 'lease_expired')
     where q.state = 'leased' and q.lease_until < now() and q.executor = p_executor
    returning q.id, q.attempts, q.max_attempts
  loop
    if r.attempts >= r.max_attempts then
      perform public.queue_mark_dead(r.id, 'lease_expired');
    end if;
  end loop;

  -- 2. Claim: only the oldest unfinished job per conversation is eligible (per-conversation FIFO).
  with candidates as (
    select q.id
    from public.outbound_queue q
    where q.executor = p_executor
      and q.state = 'ready'
      and q.run_at <= now()
      and not exists (
        select 1 from public.outbound_queue o
        where o.conversation_id = q.conversation_id
          and o.state in ('ready', 'leased')
          and o.seq < q.seq)
    order by q.run_at, q.seq
    limit greatest(coalesce(p_n, 10), 0)
    for update of q skip locked
  ), claimed as (
    update public.outbound_queue q
       set state = 'leased', lease_owner = p_worker_id, lease_until = now() + interval '60 seconds',
           attempts = q.attempts + 1
      from candidates c
     where q.id = c.id
    returning q.id
  )
  select array_agg(claimed.id) into v_ids from claimed;

  if v_ids is null then
    return;
  end if;

  update public.messages m
     set status = 'sending'
    from public.outbound_queue q
   where q.id = any (v_ids) and m.id = q.message_id and m.status = 'queued';

  return query
    select q.id, q.message_id, q.account_id, q.conversation_id, c.chat_jid, q.attempts, q.lease_until,
           m.kind, m.body, m.media_path, m.media_mime, m.template, m.quoted_provider_id,
           m.provider_message_id, m.idempotency_key, m.use_case, m.delivery_mode
    from public.outbound_queue q
    join public.messages m on m.id = q.message_id
    left join public.conversations c on c.id = q.conversation_id
    where q.id = any (v_ids)
    order by q.seq;
end
$$;

-- Extend a lease while sending. Returns the new lease_until, or null when the lease was lost.
create or replace function public.renew_lease(p_job_id uuid, p_worker_id text)
returns timestamptz
language sql
security definer
set search_path = ''
as $$
  update public.outbound_queue q
     set lease_until = now() + interval '60 seconds'
   where q.id = p_job_id and q.state = 'leased' and q.lease_owner = p_worker_id
  returning q.lease_until
$$;

-- Optional pre-send step (RL2): record the provider id generated client-side (Baileys
-- generateMessageID) BEFORE sending. A job re-claimed after a crash then comes back with
-- provider_message_id set, so the worker completes it instead of sending twice.
create or replace function public.job_reserve_provider_id(p_job_id uuid, p_worker_id text,
  p_provider_message_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg uuid;
begin
  select q.message_id into v_msg from public.outbound_queue q
  where q.id = p_job_id and q.state = 'leased' and q.lease_owner = p_worker_id;
  if v_msg is null then
    return false;
  end if;
  update public.messages m set provider_message_id = p_provider_message_id
   where m.id = v_msg and m.provider_message_id is null;
  return found;
end
$$;

-- Idempotent completion. Returns true only for the call that actually completed the job.
-- messages -> 'sent' only while it has no provider id yet (or the same reserved id).
create or replace function public.complete_job(p_job_id uuid, p_provider_message_id text,
  p_delivery_mode text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.outbound_queue%rowtype;
begin
  select * into j from public.outbound_queue where id = p_job_id for update;
  if not found then
    raise exception 'job % not found', p_job_id using errcode = 'P0002';
  end if;
  if j.state = 'done' then
    return false;
  end if;

  update public.outbound_queue
     set state = 'done', lease_owner = null, lease_until = null, last_error_code = null
   where id = p_job_id;

  update public.messages m
     set status = case when m.status in ('queued', 'sending', 'failed') then 'sent' else m.status end,
         provider_message_id = p_provider_message_id,
         sent_at = coalesce(m.sent_at, now()),
         failed_at = null,
         error_code = null,
         delivery_mode = coalesce(p_delivery_mode, m.delivery_mode)
   where m.id = j.message_id
     and (m.provider_message_id is null or m.provider_message_id = p_provider_message_id)
     and m.sent_at is null;
  return true;
end
$$;

-- Failure: permanent -> dead + message failed (no alert; visible as failed with reason).
-- Transient -> retry after 5s, 30s, 2m, 10m, 15m; after max_attempts (1 + 5 retries) -> dead + alert.
-- Returns the job's new state.
create or replace function public.fail_job(p_job_id uuid, p_error_code text, p_transient boolean,
  p_detail text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.outbound_queue%rowtype;
begin
  select * into j from public.outbound_queue where id = p_job_id for update;
  if not found then
    raise exception 'job % not found', p_job_id using errcode = 'P0002';
  end if;
  if j.state in ('done', 'dead') then
    return j.state;
  end if;

  update public.messages m set error_code = p_error_code, error_detail = p_detail
   where m.id = j.message_id;

  if not coalesce(p_transient, false) then
    perform public.queue_mark_dead(j.id, p_error_code, false);
    return 'dead';
  end if;

  if j.attempts >= j.max_attempts then
    perform public.queue_mark_dead(j.id, p_error_code, true);
    return 'dead';
  end if;

  update public.outbound_queue
     set state = 'ready', lease_owner = null, lease_until = null, last_error_code = p_error_code,
         run_at = now() + public.queue_backoff(greatest(j.attempts, 1))
   where id = j.id;
  update public.messages m set status = 'queued' where m.id = j.message_id and m.status = 'sending';
  return 'ready';
end
$$;

-- ---------------------------------------------------------------------------
-- Inbound (ARCH §4.3, §4.4). Idempotent on (account_id, provider_message_id).
-- ---------------------------------------------------------------------------
create or replace function public.ingest_inbound(
  p_account_id uuid,
  p_provider_message_id text,
  p_chat_jid text,
  p_kind text,
  p_body text default null,
  p_sender_jid text default null,
  p_from_me boolean default false,
  p_push_name text default null,
  p_received_at timestamptz default null,
  p_is_forwarded boolean default false,
  p_quoted_provider_id text default null,
  p_media_path text default null,
  p_media_mime text default null,
  p_media_seconds numeric default null,
  p_relay_state text default null,
  p_raw jsonb default null,
  p_source text default null,
  p_chat_type text default null)
returns table (message_id uuid, conversation_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_conv uuid;
  v_msg uuid;
  v_source text;
  v_at timestamptz := coalesce(p_received_at, now());
begin
  if coalesce(p_provider_message_id, '') = '' then
    raise exception 'provider_message_id required' using errcode = '22023';
  end if;
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  v_source := coalesce(p_source, case a.provider when 'baileys' then 'baileys' else 'meta' end);

  insert into public.inbound_events (org_id, account_id, source, dedupe_key, raw)
  values (a.org_id, a.id, v_source, v_source || ':' || a.id || ':' || p_provider_message_id, p_raw)
  on conflict (dedupe_key) do nothing;

  v_conv := public.ensure_conversation(a.org_id, a.id, p_chat_jid, p_chat_type);

  insert into public.messages as m (org_id, account_id, conversation_id, direction, kind, body, media_path,
    media_mime, media_seconds, status, provider_message_id, quoted_provider_id, sender_jid, from_me,
    push_name, is_forwarded, relay_state, received_at, delivered_at)
  values (a.org_id, a.id, v_conv, case when p_from_me then 'out' else 'in' end, p_kind, p_body, p_media_path,
    p_media_mime, p_media_seconds, case when p_from_me then 'sent' else 'delivered' end, p_provider_message_id,
    p_quoted_provider_id, p_sender_jid, coalesce(p_from_me, false), p_push_name,
    coalesce(p_is_forwarded, false), p_relay_state, v_at, case when p_from_me then null else now() end)
  on conflict on constraint messages_provider_id_uniq do nothing
  returning m.id into v_msg;

  if v_msg is null then
    return query select m.id, m.conversation_id, false from public.messages m
      where m.account_id = a.id and m.provider_message_id = p_provider_message_id;
    return;
  end if;

  update public.conversations c
     set last_message_at = greatest(coalesce(c.last_message_at, v_at), v_at),
         last_inbound_at = case when coalesce(p_from_me, false) then c.last_inbound_at
                                else greatest(coalesce(c.last_inbound_at, v_at), v_at) end
   where c.id = v_conv;

  update public.inbound_events e set processed_at = now()
   where e.dedupe_key = v_source || ':' || a.id || ':' || p_provider_message_id and e.processed_at is null;

  if not coalesce(p_from_me, false) then
    perform public.webhook_enqueue_event(a.org_id, a.id, 'message.received', jsonb_build_object(
      'message_id', v_msg, 'account_id', a.id, 'chat', p_chat_jid, 'from', p_sender_jid, 'type', p_kind,
      'text', p_body, 'timestamp', v_at, 'is_forwarded', coalesce(p_is_forwarded, false),
      'reply_to_id', p_quoted_provider_id));
  end if;

  return query select v_msg, v_conv, true;
end
$$;

-- Forward-only status ranking (sent < delivered < read; failed always wins; terminal
-- failed/cancelled never move). Mirrors packages/core shouldAdvanceStatus. Returns applied?
create or replace function public.message_status_rank(p_status text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3
    when 'read' then 4 when 'cancelled' then 99 when 'failed' then 100 else -1 end
$$;

create or replace function public.apply_message_status(
  p_account_id uuid,
  p_provider_message_id text,
  p_status text,
  p_at timestamptz default null,
  p_error_code text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
  v_at timestamptz := coalesce(p_at, now());
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'invalid status %', p_status using errcode = '22023';
  end if;
  select * into m from public.messages
   where account_id = p_account_id and provider_message_id = p_provider_message_id
   for update;
  if not found then
    return false;
  end if;
  if m.status in ('failed', 'cancelled') then
    return false;
  end if;
  if p_status <> 'failed' and public.message_status_rank(p_status) <= public.message_status_rank(m.status) then
    return false;
  end if;

  update public.messages
     set status = p_status,
         sent_at = case when p_status in ('sent', 'delivered', 'read') then coalesce(sent_at, v_at) else sent_at end,
         delivered_at = case when p_status in ('delivered', 'read') then coalesce(delivered_at, v_at) else delivered_at end,
         read_at = case when p_status = 'read' then coalesce(read_at, v_at) else read_at end,
         failed_at = case when p_status = 'failed' then v_at else failed_at end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, error_code) else error_code end
   where id = m.id;

  perform public.webhook_enqueue_event(m.org_id, m.account_id, 'message.status', jsonb_build_object(
    'message_id', m.id, 'provider_message_id', p_provider_message_id, 'status', p_status, 'at', v_at,
    'error_code', p_error_code));
  return true;
end
$$;
