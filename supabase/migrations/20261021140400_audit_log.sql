-- Append-only, hash-chained audit log (ARCH §5, §7.1; TEST-PLAN L6.2, L6.3, L6.4).
--
-- * hash = sha256(canonical row incl. prev_hash), computed in a BEFORE INSERT trigger
--   that serialises writers with an advisory xact lock and assigns `seq` under that lock,
--   so seq order == chain order == commit order.
-- * UPDATE / DELETE / TRUNCATE privileges revoked from every API role, and blocked by
--   triggers for everyone except a real superuser (who can also disable triggers anyway).
-- * Never touched by retention.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  seq bigint not null unique,    -- assigned by trigger, gap-free in commit order
  org_id uuid not null references public.orgs (id) on delete restrict,
  actor_type text not null check (actor_type in ('user', 'api_client', 'worker', 'system')),
  actor_id text,
  action text not null,
  target text,
  ip inet,
  meta jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  prev_hash text not null,
  hash text not null
);
create index audit_log_org_at_idx on public.audit_log (org_id, at desc);

create sequence public.audit_log_seq;

-- Canonical serialisation. jsonb normalises key order; the timestamp is rendered in UTC
-- so the hash does not depend on the session TimeZone.
create or replace function public.audit_row_hash(
  p_prev_hash text, p_seq bigint, p_org_id uuid, p_actor_type text, p_actor_id text,
  p_action text, p_target text, p_ip inet, p_meta jsonb, p_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(extensions.digest(
    jsonb_build_array(
      p_prev_hash, p_seq, p_org_id, p_actor_type, p_actor_id, p_action, p_target,
      host(p_ip), p_meta, to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )::text, 'sha256'), 'hex')
$$;

create or replace function public.audit_log_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
begin
  -- Serialise all appenders; held until commit.
  perform pg_advisory_xact_lock(hashtextextended('public.audit_log.chain', 0));
  select a.hash into v_prev from public.audit_log a order by a.seq desc limit 1;
  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.seq := nextval('public.audit_log_seq');
  new.at := now();
  new.meta := coalesce(new.meta, '{}'::jsonb);
  new.hash := public.audit_row_hash(new.prev_hash, new.seq, new.org_id, new.actor_type, new.actor_id,
    new.action, new.target, new.ip, new.meta, new.at);
  return new;
end
$$;

create trigger audit_log_chain before insert on public.audit_log
  for each row execute function public.audit_log_before_insert();

create or replace function public.audit_log_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = current_user and r.rolsuper) then
    return coalesce(old, new);   -- superuser escape hatch (documented); TRUNCATE returns null
  end if;
  raise exception 'audit_log is append-only (% denied)', tg_op using errcode = '42501';
end
$$;

create trigger audit_log_no_update_delete before update or delete on public.audit_log
  for each row execute function public.audit_log_block_mutation();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_block_mutation();

-- Verify the whole chain. ok=false and first_bad_seq point at the first broken link.
create or replace function public.audit_verify_chain()
returns table (ok boolean, checked bigint, first_bad_seq bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_prev text := repeat('0', 64);
  v_n bigint := 0;
begin
  for r in select * from public.audit_log order by seq loop
    v_n := v_n + 1;
    if r.prev_hash is distinct from v_prev
       or r.hash is distinct from public.audit_row_hash(r.prev_hash, r.seq, r.org_id, r.actor_type,
            r.actor_id, r.action, r.target, r.ip, r.meta, r.at) then
      ok := false; checked := v_n; first_bad_seq := r.seq;
      return next;
      return;
    end if;
    v_prev := r.hash;
  end loop;
  ok := true; checked := v_n; first_bad_seq := null;
  return next;
end
$$;

-- The only write path. Called by server code (service_role) and the worker.
create or replace function public.audit_append(
  p_org_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_action text,
  p_target text default null,
  p_ip inet default null,
  p_meta jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.audit_log (org_id, actor_type, actor_id, action, target, ip, meta, prev_hash, hash)
  values (p_org_id, p_actor_type, p_actor_id, p_action, p_target, p_ip, coalesce(p_meta, '{}'::jsonb), '', '')
  returning id into v_id;
  return v_id;
end
$$;
