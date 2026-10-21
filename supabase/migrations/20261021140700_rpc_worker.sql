-- Worker-side RPCs (role gateway_worker): heartbeat, single-writer lock, session events,
-- pairing, contacts, automations, relay batching, logs. Plus the server-down state machine.
-- ARCH §4.4-§4.7, §8.3, ADR-4; TEST-PLAN S5, RL5, R5.3, L3.3.

-- ---------------------------------------------------------------------------
-- Heartbeat + server-down state machine (RL5)
-- ---------------------------------------------------------------------------
create or replace function public.record_heartbeat(
  p_org_id uuid,
  p_worker_id text,
  p_version text default null,
  p_baileys_version text default null,
  p_sockets jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.heartbeat_state%rowtype;
begin
  if coalesce(p_worker_id, '') = '' then
    raise exception 'worker_id required' using errcode = '22023';
  end if;

  insert into public.worker_heartbeats (org_id, worker_id, version, baileys_version, sockets)
  values (p_org_id, p_worker_id, p_version, p_baileys_version, coalesce(p_sockets, '[]'::jsonb));

  insert into public.heartbeat_state (org_id, worker_id, status, last_seen_at)
  values (p_org_id, p_worker_id, 'up', now())
  on conflict (org_id, worker_id) do nothing;

  select * into s from public.heartbeat_state
   where org_id = p_org_id and worker_id = p_worker_id for update;

  if s.status = 'down' then
    -- Recovery: close the outage; its "recovered" mail becomes due (exactly once).
    update public.downtime_intervals set ended_at = now() where id = s.current_interval_id and ended_at is null;
    update public.alerts set resolved_at = now()
     where org_id = p_org_id and kind = 'worker_down' and ref_id = p_worker_id and resolved_at is null;
  end if;

  update public.heartbeat_state
     set status = 'up', last_seen_at = now(), down_since = null, current_interval_id = null, updated_at = now()
   where id = s.id;

  -- Per-socket heartbeat on sessions (sockets: [{"account_id": "...", ...}]).
  if jsonb_typeof(p_sockets) = 'array' then
    update public.sessions se
       set last_heartbeat_at = now()
     where se.account_id in (
       select public.try_uuid(e ->> 'account_id') from jsonb_array_elements(p_sockets) as e);
  end if;
end
$$;

-- Called every minute (pg_cron -> heartbeat-alert Edge Function). Marks workers whose last
-- heartbeat is older than p_stale as down, opening one outage row each. Idempotent.
create or replace function public.heartbeat_evaluate(p_stale interval default interval '3 minutes')
returns table (worker_id text, org_id uuid, interval_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_interval uuid;
begin
  for s in
    select h.* from public.heartbeat_state h
    where h.status = 'up' and h.last_seen_at < now() - p_stale
    for update skip locked
  loop
    insert into public.downtime_intervals (org_id, worker_id, started_at, detected_at)
    values (s.org_id, s.worker_id, s.last_seen_at, now())
    returning id into v_interval;
    update public.heartbeat_state h
       set status = 'down', down_since = s.last_seen_at, current_interval_id = v_interval, updated_at = now()
     where h.id = s.id;
    insert into public.alerts (org_id, severity, kind, ref_id, message)
    values (s.org_id, 'P1', 'worker_down', s.worker_id,
            format('Worker %s silent since %s', s.worker_id, s.last_seen_at));
    worker_id := s.worker_id; org_id := s.org_id; interval_id := v_interval;
    return next;
  end loop;
end
$$;

-- Claim owed e-mails (outbox). A lease prevents two concurrent invocations sending twice;
-- an un-acked claim (send failed) becomes claimable again after the lease.
create or replace function public.heartbeat_claim_notifications(p_lease_seconds int default 120)
returns table (interval_id uuid, org_id uuid, worker_id text, kind text, started_at timestamptz,
  detected_at timestamptz, ended_at timestamptz, duration_seconds bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id from public.downtime_intervals d
    where (d.down_email_sent_at is null or (d.ended_at is not null and d.recovered_email_sent_at is null))
      and (d.notify_lease_until is null or d.notify_lease_until < now())
    for update skip locked
  ), leased as (
    update public.downtime_intervals d
       set notify_lease_until = now() + make_interval(secs => p_lease_seconds),
           notify_attempts = d.notify_attempts + 1
      from due where d.id = due.id
    returning d.*
  )
  select l.id, l.org_id, l.worker_id, k.kind, l.started_at, l.detected_at, l.ended_at,
         extract(epoch from (l.ended_at - l.started_at))::bigint
  from leased l
  cross join lateral (
    select 'down'::text as kind, 0 as ord where l.down_email_sent_at is null
    union all
    select 'recovered', 1 where l.ended_at is not null and l.recovered_email_sent_at is null
  ) k
  order by l.detected_at, k.ord;
end
$$;

create or replace function public.heartbeat_ack_notification(p_interval_id uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'down' then
    update public.downtime_intervals set down_email_sent_at = now(), notify_lease_until = null
     where id = p_interval_id and down_email_sent_at is null;
  elsif p_kind = 'recovered' then
    update public.downtime_intervals set recovered_email_sent_at = now(), notify_lease_until = null
     where id = p_interval_id and recovered_email_sent_at is null and ended_at is not null;
  else
    raise exception 'invalid kind %', p_kind using errcode = '22023';
  end if;
  return found;
end
$$;

-- ---------------------------------------------------------------------------
-- Single writer per Baileys account (ADR-4, S5)
--
-- A plain session-level pg_try_advisory_lock is meaningless through PostgREST (pooled
-- connections, one transaction per RPC), so the lock is a lease on sessions.worker_id /
-- lock_until, taken atomically under pg_try_advisory_xact_lock. The worker must renew it
-- (call again) more often than p_ttl_seconds and stop the socket when it returns false.
-- ---------------------------------------------------------------------------
create or replace function public.worker_try_lock_account(p_account_id uuid, p_worker_id text,
  p_ttl_seconds int default 90)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  s public.sessions%rowtype;
begin
  if coalesce(p_worker_id, '') = '' then
    raise exception 'worker_id required' using errcode = '22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('gateway.account_lock:' || p_account_id::text, 0)) then
    return false;   -- another worker is acquiring right now
  end if;
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;

  insert into public.sessions (org_id, account_id) values (a.org_id, a.id)
  on conflict (account_id) do nothing;
  select * into s from public.sessions where account_id = a.id for update;

  if s.worker_id is not null and s.worker_id <> p_worker_id and s.lock_until > now() then
    return false;
  end if;
  update public.sessions
     set worker_id = p_worker_id, lock_until = now() + make_interval(secs => greatest(p_ttl_seconds, 10))
   where id = s.id;
  return true;
end
$$;

create or replace function public.worker_unlock_account(p_account_id uuid, p_worker_id text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.sessions set lock_until = null, worker_id = null
   where account_id = p_account_id and worker_id = p_worker_id
  returning true
$$;

create or replace function public.assert_lock_holder(p_account_id uuid, p_worker_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.sessions s where s.account_id = p_account_id
             and s.worker_id is distinct from p_worker_id and s.lock_until > now()) then
    raise exception 'account % is locked by another worker', p_account_id using errcode = '55P03';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Session events (ARCH §4.6). Updates sessions + accounts.status, P1 alerts.
-- ---------------------------------------------------------------------------
create or replace function public.worker_session_event(
  p_account_id uuid,
  p_worker_id text,
  p_event text,
  p_code text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_id uuid;
  v_conn text;
begin
  perform public.assert_lock_holder(p_account_id, p_worker_id);
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;

  insert into public.session_events (org_id, account_id, event, code, worker_id)
  values (a.org_id, a.id, p_event, p_code, p_worker_id)
  returning id into v_id;

  v_conn := case p_event
    when 'connecting' then 'connecting'
    when 'open' then 'open' when 'paired' then 'open' when 'relinked' then 'open' when 'restored' then 'open'
    when 'close' then 'closed'
    when 'conflict' then 'conflict'
    when 'needs_relink' then 'needs_relink' when 'logged_out' then 'needs_relink'
    else null end;

  if v_conn is not null then
    insert into public.sessions (org_id, account_id) values (a.org_id, a.id) on conflict (account_id) do nothing;
    update public.sessions
       set connection = v_conn,
           connected_at = case when v_conn = 'open' then now() else connected_at end,
           last_error_code = case when v_conn = 'open' then null else coalesce(p_code, last_error_code) end
     where account_id = a.id;
    update public.accounts set status = v_conn where id = a.id;
    perform public.webhook_enqueue_event(a.org_id, a.id, 'session.changed',
      jsonb_build_object('account_id', a.id, 'connection', v_conn, 'event', p_event, 'code', p_code));
  end if;

  if p_event in ('conflict', 'needs_relink', 'logged_out') then
    insert into public.alerts (org_id, severity, kind, account_id, ref_id, message)
    values (a.org_id, 'P1', case when p_event = 'conflict' then 'conflict' else 'needs_relink' end,
            a.id, v_id::text, format('Account %s: %s (%s)', a.label, p_event, coalesce(p_code, '-')));
  elsif v_conn = 'open' then
    update public.alerts set resolved_at = now()
     where account_id = a.id and kind in ('needs_relink', 'conflict') and resolved_at is null;
  end if;
  return v_id;
end
$$;

create or replace function public.worker_complete_session_command(p_command_id uuid, p_state text,
  p_result text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_state not in ('done', 'failed') then
    raise exception 'invalid state %', p_state using errcode = '22023';
  end if;
  update public.session_commands set state = p_state, result = p_result, consumed_at = now()
   where id = p_command_id and state = 'pending';
  return found;
end
$$;

-- ---------------------------------------------------------------------------
-- Pairing (ARCH §4.5). QR rows live <= 60 s; request <= 3 min.
-- ---------------------------------------------------------------------------
create or replace function public.worker_pairing_qr_upsert(p_request_id uuid, p_worker_id text,
  p_qr text default null, p_pairing_code text default null, p_ttl_seconds int default 60)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.pairing_requests%rowtype;
  v_id uuid;
  v_ttl interval := make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 60), 1), 60));
begin
  select * into r from public.pairing_requests where id = p_request_id for update;
  if not found or r.state not in ('pending', 'active') or r.expires_at < now() then
    raise exception 'pairing request % not active', p_request_id using errcode = '55000';
  end if;
  perform public.assert_lock_holder(r.account_id, p_worker_id);
  update public.pairing_requests set state = 'active' where id = r.id and state = 'pending';

  insert into public.pairing_qr (org_id, request_id, account_id, qr, pairing_code, created_at, expires_at)
  values (r.org_id, r.id, r.account_id, p_qr, p_pairing_code, now(), least(now() + v_ttl, r.expires_at))
  on conflict (request_id) do update
     set qr = excluded.qr, pairing_code = excluded.pairing_code, created_at = excluded.created_at,
         expires_at = excluded.expires_at
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.worker_pairing_finish(p_request_id uuid, p_worker_id text, p_state text,
  p_phone_e164 text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.pairing_requests%rowtype;
begin
  if p_state not in ('paired', 'expired', 'failed') then
    raise exception 'invalid state %', p_state using errcode = '22023';
  end if;
  select * into r from public.pairing_requests where id = p_request_id for update;
  if not found then
    return false;
  end if;
  perform public.assert_lock_holder(r.account_id, p_worker_id);
  delete from public.pairing_qr where request_id = r.id;
  update public.pairing_requests set state = p_state, completed_at = now() where id = r.id;
  if p_state = 'paired' then
    if p_phone_e164 is not null then
      update public.accounts set phone_e164 = p_phone_e164 where id = r.account_id;
    end if;
    perform public.worker_session_event(r.account_id, p_worker_id, 'paired', null);
  end if;
  perform public.audit_append(r.org_id, 'worker', p_worker_id, 'pairing.' || p_state, 'account:' || r.account_id,
    null, jsonb_build_object('request_id', r.id));
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Contacts, transcripts, relay state, logs
-- ---------------------------------------------------------------------------
create or replace function public.worker_upsert_contact(p_account_id uuid, p_pn_jid text default null,
  p_lid text default null, p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_id uuid;
begin
  if p_pn_jid is null and p_lid is null then
    raise exception 'pn_jid or lid required' using errcode = '22023';
  end if;
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  -- Merge PN/LID identities of the same person (R2.2, L1.2).
  select c.id into v_id from public.contacts c
   where c.account_id = a.id
     and ((p_lid is not null and c.lid = p_lid) or (p_pn_jid is not null and c.pn_jid = p_pn_jid))
   order by (c.lid is not null) desc
   limit 1
   for update;
  if v_id is null then
    insert into public.contacts (org_id, account_id, pn_jid, lid, display_name)
    values (a.org_id, a.id, p_pn_jid, p_lid, p_display_name)
    returning id into v_id;
  else
    update public.contacts
       set pn_jid = coalesce(pn_jid, p_pn_jid), lid = coalesce(lid, p_lid),
           display_name = coalesce(p_display_name, display_name)
     where id = v_id;
  end if;
  return v_id;
end
$$;

create or replace function public.message_set_transcript(p_message_id uuid, p_transcript text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.messages set transcript = p_transcript, transcript_ready_at = coalesce(transcript_ready_at, now())
   where id = p_message_id
  returning true
$$;

create or replace function public.worker_log(p_org_id uuid, p_worker_id text, p_entries jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  insert into public.worker_logs (org_id, worker_id, level, msg, correlation_id, data, at)
  select p_org_id, p_worker_id, coalesce(e ->> 'level', 'info'), coalesce(e ->> 'msg', ''),
         e ->> 'correlation_id', e -> 'data', coalesce((e ->> 'at')::timestamptz, now())
  from jsonb_array_elements(case when jsonb_typeof(p_entries) = 'array' then p_entries else '[]'::jsonb end) as e;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- Status-reply automations (R1, R2)
-- ---------------------------------------------------------------------------
create or replace function public.worker_upsert_status(p_account_id uuid, p_provider_status_id text,
  p_kind text default null, p_caption text default null, p_media_path text default null,
  p_posted_at timestamptz default null, p_expires_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_id uuid;
  v_new boolean;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  insert into public.statuses (org_id, account_id, provider_status_id, kind, caption, media_path, posted_at, expires_at)
  values (a.org_id, a.id, p_provider_status_id, p_kind, p_caption, p_media_path, coalesce(p_posted_at, now()),
          coalesce(p_expires_at, coalesce(p_posted_at, now()) + interval '24 hours'))
  on conflict (account_id, provider_status_id) do update set caption = coalesce(excluded.caption, public.statuses.caption)
  returning id, (xmax = 0) into v_id, v_new;
  if v_new then
    -- "Next status I post" automations bind to the first new status (R1.2).
    update public.automations set status_id = v_id, bind_mode = 'status'
     where account_id = a.id and bind_mode = 'next_status' and status_id is null and enabled;
  end if;
  return v_id;
end
$$;

-- One reply per contact per status (R2.2): true only for the first caller.
create or replace function public.worker_take_cooldown(p_account_id uuid, p_provider_status_id text,
  p_contact_key text, p_automation_id uuid default null, p_status_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select org_id into v_org from public.accounts where id = p_account_id;
  if v_org is null then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  insert into public.automation_cooldowns (org_id, account_id, automation_id, status_id, provider_status_id, contact_key)
  values (v_org, p_account_id, p_automation_id, p_status_id, p_provider_status_id, p_contact_key)
  on conflict (account_id, provider_status_id, contact_key) do nothing
  returning id into v_id;
  return v_id is not null;
end
$$;

create or replace function public.worker_record_reply_job(p_account_id uuid, p_outcome text,
  p_automation_id uuid default null, p_status_id uuid default null, p_inbound_message_id uuid default null,
  p_outbound_message_id uuid default null, p_contact_key text default null, p_detail text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select org_id into v_org from public.accounts where id = p_account_id;
  if v_org is null then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  insert into public.reply_jobs (org_id, account_id, automation_id, status_id, inbound_message_id,
    outbound_message_id, contact_key, outcome, detail)
  values (v_org, p_account_id, p_automation_id, p_status_id, p_inbound_message_id, p_outbound_message_id,
    p_contact_key, p_outcome, p_detail)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Agent relay batches (ARCH §4.7, ADR-6). Idempotent on batch_id.
-- ---------------------------------------------------------------------------
create or replace function public.worker_create_relay_batch(
  p_relay_target_id uuid,
  p_message_ids uuid[],
  p_conversation_id uuid default null,
  p_is_test boolean default false,
  p_batch_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.relay_targets%rowtype;
  v_batch uuid := coalesce(p_batch_id, gen_random_uuid());
  v_first timestamptz;
begin
  select * into t from public.relay_targets where id = p_relay_target_id;
  if not found then
    raise exception 'relay target % not found', p_relay_target_id using errcode = 'P0002';
  end if;
  if p_message_ids is null or cardinality(p_message_ids) = 0 then
    raise exception 'message_ids required' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_message_ids) x(id)
             where not exists (select 1 from public.messages m where m.id = x.id and m.account_id = t.account_id)) then
    raise exception 'message_ids must belong to the relay target account' using errcode = '22023';
  end if;
  select min(coalesce(m.received_at, m.created_at)) into v_first from public.messages m where m.id = any (p_message_ids);

  insert into public.relay_batches (org_id, batch_id, relay_target_id, account_id, conversation_id, message_ids,
    is_test, first_message_at)
  values (t.org_id, v_batch, t.id, t.account_id, p_conversation_id, p_message_ids, coalesce(p_is_test, false), v_first)
  on conflict (batch_id) do nothing;

  update public.messages set relay_state = 'batched'
   where id = any (p_message_ids) and relay_state is distinct from 'batched';
  return v_batch;
end
$$;
