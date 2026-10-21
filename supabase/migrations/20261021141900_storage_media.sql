-- Private `media` Storage bucket + policies (ARCH §7.1, TEST-PLAN S9) and the consumer side of
-- media_purge_queue (retention, S11 / task 3.5).
--
-- Object paths: `<org_id>/<account_id>/<provider_message_id>` (worker inbound media, Cloud media
-- downloaded by the server). Access:
--   gateway_worker  INSERT + SELECT on bucket `media`, only under an existing org's prefix
--                   (and the JWT's `org_id` claim when present);
--   service_role    everything on bucket `media` (signing, Cloud downloads, purge);
--   authenticated   nothing: dashboard users get ≤15-min signed URLs from server actions only;
--   anon            nothing.
-- Guarded: on a database without the `storage` schema (plain Postgres) this is a no-op.

-- Path guard for the worker policies (security definer: the worker cannot read public.orgs).
create or replace function public.storage_worker_path_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_name is not null
    and p_name !~ '(^|/)\.\.(/|$)'
    and exists (select 1 from public.orgs o where o.id = public.try_uuid(split_part(p_name, '/', 1)))
    and coalesce(nullif(auth.jwt() ->> 'org_id', ''), split_part(p_name, '/', 1)) = split_part(p_name, '/', 1)
    and split_part(p_name, '/', 2) <> ''
$$;

revoke all on function public.storage_worker_path_ok(text)
  from public, anon, authenticated, service_role, gateway_worker;
grant execute on function public.storage_worker_path_ok(text) to gateway_worker;

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage schema absent: media bucket and policies skipped';
    return;
  end if;

  insert into storage.buckets (id, name, public) values ('media', 'media', false)
  on conflict (id) do update set public = false;

  execute 'grant usage on schema storage to gateway_worker';
  execute 'grant select, insert on storage.objects to gateway_worker';

  execute 'drop policy if exists gw_media_worker_insert on storage.objects';
  execute 'drop policy if exists gw_media_worker_select on storage.objects';
  execute 'drop policy if exists gw_media_service_all on storage.objects';
  execute $p$create policy gw_media_worker_insert on storage.objects for insert to gateway_worker
    with check (bucket_id = 'media' and (select public.storage_worker_path_ok(name)))$p$;
  execute $p$create policy gw_media_worker_select on storage.objects for select to gateway_worker
    using (bucket_id = 'media' and (select public.storage_worker_path_ok(name)))$p$;
  execute $p$create policy gw_media_service_all on storage.objects for all to service_role
    using (bucket_id = 'media') with check (bucket_id = 'media')$p$;
  -- Deliberately no policy for `authenticated` / `anon` on bucket `media` (S9).
end
$$;

-- ---------------------------------------------------------------------------
-- media_purge_queue consumer (Edge Function `media-purge`, pg_cron every 10 minutes).
-- Files are deleted through the Storage API (a direct DELETE on storage.objects would orphan them).
-- ---------------------------------------------------------------------------
alter table public.media_purge_queue
  add column attempts int not null default 0,
  add column lease_until timestamptz,
  add column last_error text;
create index media_purge_queue_open_idx on public.media_purge_queue (created_at) where purged_at is null;

create or replace function public.media_purge_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.media_purge_queue q
                 where q.purged_at is null and q.attempts < 10
                   and (q.lease_until is null or q.lease_until < now()))
$$;

create or replace function public.media_purge_claim(p_n int default 100)
returns table (id uuid, bucket text, path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id from public.media_purge_queue q
    where q.purged_at is null and q.attempts < 10 and (q.lease_until is null or q.lease_until < now())
    order by q.created_at
    limit least(greatest(coalesce(p_n, 100), 0), 1000)
    for update skip locked
  ), upd as (
    update public.media_purge_queue q
       set lease_until = now() + interval '5 minutes', attempts = q.attempts + 1
      from due where q.id = due.id
    returning q.id, q.bucket, q.path
  )
  select upd.id, upd.bucket, upd.path from upd;
end
$$;

-- Storage API confirmed the removal (an already-missing object counts as removed).
create or replace function public.media_purge_ack(p_ids uuid[], p_error text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  if p_error is null then
    update public.media_purge_queue set purged_at = now(), lease_until = null, last_error = null
     where id = any (p_ids) and purged_at is null;
  else
    update public.media_purge_queue set lease_until = null, last_error = left(p_error, 200)
     where id = any (p_ids) and purged_at is null;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed; schedules skipped';
    return;
  end if;
  perform cron.unschedule(c.jobid) from cron.job c where c.jobname = 'gw-media-purge';
  perform cron.schedule('gw-media-purge', '*/10 * * * *',
    $c$select public.invoke_edge_function('media-purge') where public.media_purge_due()$c$);
end
$$;

revoke all on function
  public.media_purge_due(),
  public.media_purge_claim(int),
  public.media_purge_ack(uuid[], text)
from public, anon, authenticated, service_role, gateway_worker;
grant execute on function
  public.media_purge_claim(int),
  public.media_purge_ack(uuid[], text)
to service_role;
