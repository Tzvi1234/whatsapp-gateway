-- Reminder dispatcher (TEST-PLAN R4.1-R4.6, R4.8, S13).
--
--   pg_cron (gw-reminders, every minute) -> reminders_dispatch_due():
--     * due reminders of Cloud accounts without credentials -> 'unconfigured' (attempts untouched, R4.4)
--     * 'unconfigured' reminders whose account now has credentials -> 'scheduled' again
--     * work due -> Edge Function `reminders-dispatch`, which claims with reminders_claim_due()
--       and hands each reminder to Vercel POST /api/internal/reminders.
--   Vercel runs THE send gate (`reminders.dispatch`): text inside the 24h window, an approved
--   template outside it, else `outside_24h_window` (R4.2); then enqueue_message with idempotency
--   key `reminder:<id>` (Cloud: direct Graph send; Baileys: worker queue) and
--   reminder_record_dispatch(). Afterwards a trigger keeps reminders.state in sync with the
--   message status. Nothing here sends from SQL.

alter table public.reminders
  add column client_reminder_id text,
  add column error_detail text,
  add column lease_owner text,
  add column lease_until timestamptz,
  add constraint reminders_client_id_uniq unique (api_client_id, client_reminder_id);
create index reminders_message_idx on public.reminders (message_id) where message_id is not null;

-- Cloud account has what a Graph send needs.
create or replace function public.account_send_configured(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case a.provider
    when 'meta_cloud' then exists (
      select 1 from public.provider_credentials c
      where c.account_id = a.id and c.phone_number_id is not null and c.vault_secret_id is not null)
    else true end
  from public.accounts a where a.id = p_account_id
$$;

-- ---------------------------------------------------------------------------
-- Create (MCP send_reminder / legacy). Idempotent on (api_client_id, client_reminder_id).
-- ---------------------------------------------------------------------------
create or replace function public.reminder_create(
  p_account_id uuid,
  p_to_e164 text,
  p_due_at timestamptz,
  p_body text default null,
  p_template_name text default null,
  p_template_language text default null,
  p_template_params jsonb default '[]'::jsonb,
  p_api_client_id uuid default null,
  p_client_reminder_id text default null,
  p_created_by uuid default null)
returns table (reminder_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_id uuid;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  if coalesce(p_body, '') = '' and (p_template_name is null or p_template_language is null) then
    raise exception 'reminder needs text or a template' using errcode = '22023';
  end if;
  insert into public.reminders as r (org_id, account_id, to_e164, body, template_name, template_language,
    template_params, due_at, state, api_client_id, client_reminder_id, created_by)
  values (a.org_id, a.id, p_to_e164, nullif(p_body, ''), p_template_name, p_template_language,
    coalesce(p_template_params, '[]'::jsonb), coalesce(p_due_at, now()),
    case when public.account_send_configured(a.id) then 'scheduled' else 'unconfigured' end,
    p_api_client_id, p_client_reminder_id, p_created_by)
  on conflict (api_client_id, client_reminder_id) do nothing
  returning r.id into v_id;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  return query select r.id, false from public.reminders r
    where r.api_client_id = p_api_client_id and r.client_reminder_id = p_client_reminder_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Cron entry (every minute). Returns the number of reminders ready to dispatch.
-- ---------------------------------------------------------------------------
create or replace function public.reminders_dispatch_due()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due int;
begin
  -- R4.4: no credentials -> unconfigured, attempts untouched; credentials back -> scheduled.
  update public.reminders r set state = 'unconfigured', lease_owner = null, lease_until = null
   where r.state = 'scheduled' and r.due_at <= now() and not public.account_send_configured(r.account_id);
  update public.reminders r set state = 'scheduled', error_code = null
   where r.state = 'unconfigured' and public.account_send_configured(r.account_id);

  select count(*) into v_due from public.reminders r
   where (r.state = 'scheduled' and r.due_at <= now() and (r.lease_until is null or r.lease_until < now()))
      or (r.state = 'sending' and r.message_id is null and r.lease_until < now());
  if v_due > 0 then
    perform public.invoke_edge_function('reminders-dispatch', jsonb_build_object('due', v_due));
  end if;
  return v_due;
end
$$;

-- Claim due reminders for dispatch (state -> 'sending', 60 s lease). Expired dispatches whose
-- message was never linked are re-claimed (the enqueue is idempotent on `reminder:<id>`).
create or replace function public.reminders_claim_due(p_worker_id text, p_n int default 20)
returns table (reminder_id uuid, account_id uuid, attempts int, lease_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select r.id from public.reminders r
    where ((r.state = 'scheduled' and r.due_at <= now() and (r.lease_until is null or r.lease_until < now()))
        or (r.state = 'sending' and r.message_id is null and r.lease_until < now()))
      and public.account_send_configured(r.account_id)
    order by r.due_at
    limit greatest(coalesce(p_n, 20), 0)
    for update of r skip locked
  ), upd as (
    update public.reminders r
       set state = 'sending', lease_owner = p_worker_id, lease_until = now() + interval '60 seconds'
      from due where r.id = due.id
    returning r.id, r.account_id, r.attempts, r.lease_until
  )
  select upd.id, upd.account_id, upd.attempts, upd.lease_until from upd;
end
$$;

-- Outcome of one dispatch attempt (Vercel). Exactly one of:
--   p_unconfigured  -> 'unconfigured' WITHOUT using an attempt (R4.4)
--   p_message_id    -> linked; state follows the message status from now on
--   p_error_code    -> 'failed' with the gate/provider reason (e.g. outside_24h_window, R4.2)
-- Only applies while the reminder is being dispatched (state 'sending', no message yet).
create or replace function public.reminder_record_dispatch(
  p_reminder_id uuid,
  p_message_id uuid default null,
  p_error_code text default null,
  p_detail text default null,
  p_unconfigured boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.reminders%rowtype;
  v_state text;
begin
  select * into r from public.reminders where id = p_reminder_id for update;
  if not found then
    raise exception 'reminder % not found', p_reminder_id using errcode = 'P0002';
  end if;
  if r.state <> 'sending' or r.message_id is not null then
    return r.state;  -- cancelled / already linked: idempotent no-op
  end if;
  if coalesce(p_unconfigured, false) then
    update public.reminders set state = 'unconfigured', lease_owner = null, lease_until = null,
      error_code = 'provider_unconfigured'
     where id = r.id;
    return 'unconfigured';
  end if;
  if p_message_id is not null then
    select m.status into v_state from public.messages m
     where m.id = p_message_id and m.account_id = r.account_id and m.direction = 'out';
    if v_state is null then
      raise exception 'message % does not belong to the reminder account', p_message_id using errcode = '22023';
    end if;
    update public.reminders
       set message_id = p_message_id, state = v_state, attempts = r.attempts + 1, lease_owner = null,
           lease_until = null, error_code = case when v_state = 'failed' then
             (select m.error_code from public.messages m where m.id = p_message_id) else null end,
           error_detail = null
     where id = r.id;
    return v_state;
  end if;
  update public.reminders
     set state = 'failed', attempts = r.attempts + 1, error_code = coalesce(p_error_code, 'internal'),
         error_detail = left(p_detail, 200), lease_owner = null, lease_until = null
   where id = r.id;
  return 'failed';
end
$$;

-- reminders.state follows its message (queued -> sending -> sent -> delivered -> read / failed).
create or replace function public.reminders_follow_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.reminders r
     set state = new.status,
         error_code = case when new.status = 'failed' then new.error_code else null end
   where r.message_id = new.id and r.state <> 'cancelled' and r.state is distinct from new.status;
  return null;
end
$$;

create trigger messages_reminder_state after update of status on public.messages
  for each row when (old.status is distinct from new.status)
  execute function public.reminders_follow_message();

-- R4.6: cancel only before the send (scheduled / unconfigured); otherwise 55000 with the state.
create or replace function public.reminder_cancel(p_reminder_id uuid, p_account_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.reminders%rowtype;
begin
  select * into r from public.reminders where id = p_reminder_id and account_id = p_account_id for update;
  if not found then
    raise exception 'reminder % not found', p_reminder_id using errcode = 'P0002';
  end if;
  if r.state not in ('scheduled', 'unconfigured') then
    raise exception 'reminder_already_%', r.state using errcode = '55000';
  end if;
  update public.reminders set state = 'cancelled', cancelled_at = now(), lease_owner = null, lease_until = null
   where id = r.id;
  return 'cancelled';
end
$$;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed; schedules skipped';
    return;
  end if;
  perform cron.unschedule(c.jobid) from cron.job c where c.jobname = 'gw-reminders';
  perform cron.schedule('gw-reminders', '* * * * *', $c$select public.reminders_dispatch_due()$c$);
end
$$;

revoke all on function
  public.account_send_configured(uuid),
  public.reminder_create(uuid, text, timestamptz, text, text, text, jsonb, uuid, text, uuid),
  public.reminders_dispatch_due(),
  public.reminders_claim_due(text, int),
  public.reminder_record_dispatch(uuid, uuid, text, text, boolean),
  public.reminders_follow_message(),
  public.reminder_cancel(uuid, uuid)
from public, anon, authenticated, service_role, gateway_worker;

grant execute on function
  public.reminder_create(uuid, text, timestamptz, text, text, text, jsonb, uuid, text, uuid),
  public.reminders_dispatch_due(),
  public.reminders_claim_due(text, int),
  public.reminder_record_dispatch(uuid, uuid, text, text, boolean),
  public.reminder_cancel(uuid, uuid)
to service_role;
