-- WhatsApp Gateway: foundation (extensions, roles, shared helpers).
-- Conventions (ARCHITECTURE.md §5): uuid PKs, timestamptz, org_id on every row,
-- text + CHECK for enums (easy to evolve), RLS on every table (see *_rls.sql),
-- security definer RPCs with `set search_path = ''` and fully-qualified names.

create extension if not exists pgcrypto with schema extensions;

-- Worker role (ARCH §5, §7.2). NOLOGIN: the worker reaches PostgREST/Realtime with a
-- custom JWT whose `role` claim is `gateway_worker` (never the service-role key).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gateway_worker') then
    create role gateway_worker nologin noinherit;
  end if;
  -- PostgREST switches into the JWT role from `authenticator`.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant gateway_worker to authenticator;
  end if;
end
$$;

grant usage on schema public to gateway_worker;
grant usage on schema extensions to gateway_worker;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Safe uuid cast: null instead of an exception (used for Realtime topic parsing).
create or replace function public.try_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p::uuid;
exception when others then
  return null;
end
$$;

-- E.164 check for a whole array (CHECK constraints cannot use subqueries).
create or replace function public.is_e164_array(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(x ~ '^\+[1-9][0-9]{6,14}$'), true)
  from unnest(p) as x
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Retry schedules (ARCH §8.2 queue, §4.7 webhooks). attempt is 1-based (attempts made so far).
create or replace function public.queue_backoff(p_attempt int)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    when p_attempt <= 1 then interval '5 seconds'
    when p_attempt = 2 then interval '30 seconds'
    when p_attempt = 3 then interval '2 minutes'
    when p_attempt = 4 then interval '10 minutes'
    else interval '15 minutes'
  end
$$;

create or replace function public.webhook_backoff(p_attempt int)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    when p_attempt <= 1 then interval '10 seconds'
    when p_attempt = 2 then interval '30 seconds'
    when p_attempt = 3 then interval '2 minutes'
    when p_attempt = 4 then interval '10 minutes'
    when p_attempt = 5 then interval '30 minutes'
    else interval '2 hours'
  end
$$;
