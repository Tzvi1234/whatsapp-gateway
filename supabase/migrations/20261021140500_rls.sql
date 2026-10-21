-- Row level security (ARCH §5 "RLS approach", §7.5; TEST-PLAN S6, R5.2, R5.3).
--
-- Model
--   anon            : nothing (no grants, no policies).
--   authenticated   : SELECT only, own org only, and only at AAL2 (TOTP). No direct writes:
--                     the server performs writes through security definer RPCs.
--                     pairing_*, provider_credentials, api_clients: owner + AAL2 only.
--   gateway_worker  : worker RPCs + direct read/write of baileys_auth_state, sessions,
--                     messages; read-only on the config/queue tables it must watch
--                     (Realtime postgres_changes needs SELECT + a policy).
--   service_role    : Vercel server only (BYPASSRLS on Supabase). audit_log is SELECT-only
--                     (append via audit_append), baileys_auth_state is not accessible.
--   baileys_auth_state has no policy for any user role.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
     and exists (
       select 1 from public.org_members m
       where m.org_id = p_org_id and m.user_id = (select auth.uid())
     )
$$;

create or replace function public.is_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
     and exists (
       select 1 from public.org_members m
       where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.role = 'owner'
     )
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table in public (S6 loops over all of them)
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges: start from zero for API roles, then grant narrowly
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated, gateway_worker;
revoke all on all sequences in schema public from anon, authenticated, gateway_worker;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Dashboard users: select on member-visible tables.
grant select on
  public.orgs, public.org_members, public.accounts, public.sessions, public.session_events,
  public.contacts, public.conversations, public.messages, public.outbound_queue, public.session_commands,
  public.inbound_events, public.statuses, public.automations, public.automation_cooldowns, public.reply_jobs,
  public.reminders, public.relay_targets, public.relay_batches, public.webhook_endpoints,
  public.webhook_deliveries, public.alerts, public.worker_heartbeats, public.worker_logs,
  public.heartbeat_state, public.downtime_intervals, public.audit_log,
  public.pairing_requests, public.pairing_qr, public.provider_credentials
to authenticated;
-- api_clients: never expose key_hash to browsers.
grant select (id, org_id, name, key_prefix, scopes, account_ids, conversation_ids, rate_limit, legacy,
  created_by, created_at, expires_at, revoked_at, last_used_at) on public.api_clients to authenticated;

-- Worker.
grant select, insert, update, delete on public.baileys_auth_state to gateway_worker;
grant select, insert, update on public.sessions, public.messages to gateway_worker;
grant select on
  public.accounts, public.conversations, public.contacts, public.outbound_queue, public.session_commands,
  public.pairing_requests, public.relay_targets, public.relay_batches, public.automations, public.statuses,
  public.automation_cooldowns
to gateway_worker;

-- Server (service_role): full DML except the append-only / secret-bearing tables.
revoke all on public.audit_log from service_role;
grant select on public.audit_log to service_role;
revoke all on public.baileys_auth_state from service_role;

-- Nobody but the owner may mutate audit rows (and the owner is blocked by trigger).
revoke insert, update, delete, truncate on public.audit_log from public, anon, authenticated, service_role, gateway_worker;

-- ---------------------------------------------------------------------------
-- Policies: dashboard users
-- ---------------------------------------------------------------------------
create policy orgs_select_member on public.orgs
  for select to authenticated using ((select public.is_member(id)));

do $$
declare
  t text;
begin
  foreach t in array array[
    'org_members', 'accounts', 'sessions', 'session_events', 'contacts', 'conversations', 'messages',
    'outbound_queue', 'session_commands', 'inbound_events', 'statuses', 'automations',
    'automation_cooldowns', 'reply_jobs', 'reminders', 'relay_targets', 'relay_batches',
    'webhook_endpoints', 'webhook_deliveries', 'alerts', 'worker_heartbeats', 'worker_logs',
    'heartbeat_state', 'downtime_intervals', 'audit_log'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_member(org_id)))',
      t || '_select_member', t);
  end loop;

  foreach t in array array['pairing_requests', 'pairing_qr', 'provider_credentials', 'api_clients'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_owner(org_id)))',
      t || '_select_owner', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Policies: worker
-- ---------------------------------------------------------------------------
create policy baileys_auth_state_worker on public.baileys_auth_state
  for all to gateway_worker using (true) with check (true);
create policy sessions_worker on public.sessions
  for all to gateway_worker using (true) with check (true);
create policy messages_worker on public.messages
  for all to gateway_worker using (true) with check (true);

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'conversations', 'contacts', 'outbound_queue', 'session_commands', 'pairing_requests',
    'relay_targets', 'relay_batches', 'automations', 'statuses', 'automation_cooldowns'
  ] loop
    execute format('create policy %I on public.%I for select to gateway_worker using (true)',
      t || '_select_worker', t);
  end loop;
end
$$;

-- Tables with RLS enabled and deliberately NO policy for any API role:
--   baileys_auth_state (worker only, above), login_attempts, rate_limit_buckets, media_purge_queue.
