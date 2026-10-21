-- S6 / R5.2 / R5.3 / C5: RLS and privileges on EVERY public table.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

-- Fixture really covers every table (otherwise "sees nothing" proves nothing).
select ok(
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.tablename), false, true, '')))[1]::text::int > 0,
  format('S6 fixture: public.%s has at least one row', t.tablename))
from pg_tables t where t.schemaname = 'public' order by t.tablename;

select ok(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0,
  'S6 RLS is enabled on every public table');

-- anon: reads nothing, writes nothing, on every table.
select ok(tests.try_sql('anon', '{"role": "anon"}', format('select * from public.%I', t.tablename)) in ('err:42501', 'ok:0'),
  format('S6 anon cannot read public.%s', t.tablename))
from pg_tables t where t.schemaname = 'public' order by t.tablename;

-- Write probes for every table x identity: insert / update / delete must all be denied.
create temp table s6_identities (label text, role text, claims jsonb) on commit drop;
insert into s6_identities values
  ('anon', 'anon', '{"role": "anon"}'),
  ('other-org owner (aal2)', 'authenticated', tests.claims('owner_b', 'aal2')),
  ('own-org owner at AAL1', 'authenticated', tests.claims('owner_a', 'aal1')),
  ('own-org owner (aal2)', 'authenticated', tests.claims('owner_a', 'aal2'));

select is(
  tests.try_sql(i.role, i.claims, s.stmt), 'err:42501',
  format('S6 %s: %s denied on public.%s', i.label, s.op, s.tablename))
from s6_identities i
cross join lateral (
  select t.tablename, 'INSERT' as op, format('insert into public.%I default values', t.tablename) as stmt
  from pg_tables t where t.schemaname = 'public'
  union all
  select t.tablename, 'UPDATE', format('update public.%I set %I = %I', t.tablename, a.attname, a.attname)
  from pg_tables t
  cross join lateral (
    select pa.attname from pg_attribute pa
    where pa.attrelid = format('public.%I', t.tablename)::regclass and pa.attnum > 0 and not pa.attisdropped
      and pa.attidentity = '' and pa.attgenerated = ''
    order by pa.attnum limit 1) a
  where t.schemaname = 'public'
  union all
  select t.tablename, 'DELETE', format('delete from public.%I', t.tablename)
  from pg_tables t where t.schemaname = 'public'
) s
order by i.label, s.tablename, s.op;

-- Other org (AAL2) and own org at AAL1: read nothing.
select ok(tests.try_sql('authenticated', tests.claims('owner_b', 'aal2'),
            format('select * from public.%I where org_id = %L', t.tablename, tests.id('org_a'))) in ('err:42501', 'ok:0'),
  format('S6 other-org user reads no org A rows in public.%s', t.tablename))
from pg_tables t where t.schemaname = 'public' and t.tablename not in ('rate_limit_buckets') order by t.tablename;

select ok(tests.try_sql('authenticated', tests.claims('owner_a', 'aal1'), format('select * from public.%I', t.tablename))
            in ('err:42501', 'ok:0'),
  format('R5.2 AAL1 user reads nothing in public.%s', t.tablename))
from pg_tables t where t.schemaname = 'public' order by t.tablename;

select ok(tests.try_sql('authenticated', tests.claims('owner_b', 'aal2'),
            format('select * from public.%I where org_id = %L', v.viewname, tests.id('org_a'))) in ('err:42501', 'ok:0'),
  format('S6 other-org user reads no org A rows in view public.%s', v.viewname))
from pg_views v where v.schemaname = 'public' order by v.viewname;

select ok(tests.try_sql('anon', '{"role": "anon"}', format('select * from public.%I', v.viewname)) in ('err:42501', 'ok:0'),
  format('S6 anon cannot read view public.%s', v.viewname))
from pg_views v where v.schemaname = 'public' order by v.viewname;

-- Positive controls: RLS is not just deny-all.
select is(tests.try_sql('authenticated', tests.claims('viewer_a'), 'select * from public.messages'), 'ok:3',
  'S6 member (AAL2) sees own org messages');
select is(tests.try_sql('authenticated', tests.claims('owner_b'), 'select * from public.messages'), 'ok:1',
  'S6 org B owner sees only org B messages');
select is(tests.try_sql('authenticated', tests.claims('owner_a'), 'select * from public.pairing_qr'), 'ok:1',
  'R5.3 owner at AAL2 sees the live QR');
select is(tests.try_sql('authenticated', tests.claims('viewer_a'), 'select * from public.pairing_qr'), 'ok:0',
  'R5.3 non-owner member does not see the QR');
select is(tests.try_sql('authenticated', tests.claims('viewer_a'), 'select * from public.pairing_requests'), 'ok:0',
  'R5.3 non-owner member does not see pairing requests');
select is(tests.try_sql('authenticated', tests.claims('owner_a', 'aal1'), 'select * from public.pairing_qr'), 'ok:0',
  'R5.3 owner at AAL1 does not see the QR');
select is(tests.try_sql('authenticated', tests.claims('viewer_a'), 'select * from public.provider_credentials'), 'ok:0',
  'C5 non-owner does not see provider credential metadata');
select is(tests.try_sql('authenticated', tests.claims('owner_a'), 'select key_hash from public.api_clients'), 'err:42501',
  'S8 key_hash is never readable by dashboard users');
select is(tests.try_sql('authenticated', tests.claims('owner_a'), 'select id, key_prefix, scopes from public.api_clients'),
  'ok:1', 'S8 owner can list key metadata');
select is(tests.try_sql('authenticated', tests.claims('owner_a'), 'select * from public.baileys_auth_state'), 'err:42501',
  'S4 baileys_auth_state not readable by dashboard users');
select is(tests.try_sql('service_role', '{"role": "service_role"}', 'select * from public.baileys_auth_state'), 'err:42501',
  'S4 baileys_auth_state not readable by service_role');
select is(tests.try_sql('authenticated', tests.claims('viewer_a'), 'select * from public.v_failed_rate_by_provider'),
  'ok:2', 'S6 metrics view returns own org rows to a member (security_invoker)');

-- C5: no plaintext secret anywhere in provider_credentials.
select ok(not exists (select 1 from public.provider_credentials c
                      where row_to_json(c)::text ~ '(EAAtesttoken1234|appsecret5678|verify9012)'),
  'C5 provider_credentials rows contain no plaintext secrets');
select is((select token_last4 from public.provider_credentials where account_id = tests.id('acc_a_cloud')), '1234',
  'C5 only last 4 chars of the token are stored');

-- gateway_worker: limited to its tables + RPCs.
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}', 'select * from public.outbound_queue'), 'ok:1',
  'S6 worker can read the queue');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format('update public.sessions set last_error_code = null where account_id = %L', tests.id('acc_a'))), 'ok:1',
  'S6 worker can write sessions');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}', format('select * from public.%I', t)), 'err:42501',
  format('S6 worker cannot read public.%s', t))
from unnest(array['audit_log', 'api_clients', 'provider_credentials', 'login_attempts', 'rate_limit_buckets',
  'pairing_qr', 'org_members', 'webhook_endpoints', 'alerts']) t;
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}', s), 'err:42501', format('S6 worker denied: %s', s))
from unnest(array[
  'insert into public.outbound_queue default values',
  'delete from public.messages',
  $s$select public.vault_read_secret(gen_random_uuid())$s$,
  $s$select public.create_api_client(gen_random_uuid(), 'x', 'p', repeat('a', 64), '{}')$s$,
  $s$select * from public.lookup_api_client('gw_test1')$s$,
  $s$select public.retention_run()$s$]) s;

-- Function privileges: anon executes nothing; authenticated only the RLS helpers.
select is(
  (select array_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
  null::name[], 'S6 anon can execute no public function');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')),
  array['is_member', 'is_owner', 'realtime_topic_allowed'], 'S6 authenticated can execute only the RLS helpers');

-- Private Realtime topics.
select is(tests.run_as('authenticated', tests.claims('owner_a'),
  format($s$select set_config('realtime.topic', 'org:%s:pairing', true) || public.realtime_topic_allowed(realtime.topic())::text$s$,
         tests.id('org_a'))), format('org:%s:pairing', tests.id('org_a')) || 'true',
  'R5.3 owner may join the private pairing topic');
select is(tests.run_as('authenticated', tests.claims('viewer_a'),
  format($s$select public.realtime_topic_allowed('org:%s:pairing')::text$s$, tests.id('org_a'))), 'false',
  'R5.3 viewer may not join the pairing topic');
select is(tests.run_as('authenticated', tests.claims('viewer_a'),
  format($s$select public.realtime_topic_allowed('org:%s:sessions')::text$s$, tests.id('org_a'))), 'true',
  'S6 member may join own org sessions topic');
select is(tests.run_as('authenticated', tests.claims('owner_b'),
  format($s$select public.realtime_topic_allowed('org:%s:sessions')::text$s$, tests.id('org_a'))), 'false',
  'S6 other-org user may not join org A topics');

select * from finish();
rollback;
