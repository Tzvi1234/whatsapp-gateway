-- L6.1, L6.2, L6.3: allowlist audit, append-only audit_log, hash chain.
begin;
set local client_min_messages = warning;
select plan(25);
select tests.create_fixture();

-- L6.1 allowlist change: confirmation required; audit row with who, when, before, after.
select throws_ok(
  format($s$select public.relay_allowlist_update(%L, array['+15550000009'], %L, false)$s$,
         tests.id('target_a'), tests.id('owner_a')),
  '22023', null, 'L6.1 allowlist change without confirmation is rejected');
select is(
  public.relay_allowlist_update(tests.id('target_a'), array['+15550000009', '+15550000009', '+15550000010'],
    tests.id('owner_a'), true, '198.51.100.7'),
  array['+15550000009', '+15550000010'], 'L6.1 allowlist updated (deduplicated)');
select results_eq(
  $s$select actor_type, actor_id, action, meta -> 'before', meta -> 'after', host(ip)
     from public.audit_log where action = 'relay_allowlist.update'$s$,
  format($s$values ('user'::text, %L::text, 'relay_allowlist.update'::text, '[]'::jsonb,
     '["+15550000009", "+15550000010"]'::jsonb, '198.51.100.7'::text)$s$, tests.id('owner_a')),
  'L6.1 audit row records who, before and after');
select ok((select at is not null from public.audit_log where action = 'relay_allowlist.update'),
  'L6.1 audit row records when');
select is(
  (select count(*)::int from public.audit_log where action = 'relay_target.create'), 1,
  'relay_set_target writes an audit row');
select ok(
  (select meta::text !~ 'sekret-key' from public.audit_log where action = 'relay_target.create'),
  'L5.6 audit meta never contains the sender key');

-- L6.2: UPDATE / DELETE / TRUNCATE / direct INSERT denied for every API role.
select is(tests.try_sql(r.role, r.claims, s.stmt), 'err:42501', format('L6.2 %s denied for %s', s.op, r.role))
from (values
  ('authenticated', tests.claims('owner_a')),
  ('gateway_worker', '{"role": "gateway_worker"}'::jsonb),
  ('service_role', '{"role": "service_role"}'::jsonb)) as r (role, claims)
cross join (values
  ('UPDATE', $s$update public.audit_log set action = 'x'$s$),
  ('DELETE', $s$delete from public.audit_log$s$),
  ('TRUNCATE', $s$truncate public.audit_log$s$),
  ('INSERT', $s$insert into public.audit_log (org_id, actor_type, action, prev_hash, hash)
                select org_id, 'system', 'forged', '', '' from public.orgs limit 1$s$)) as s (op, stmt)
order by r.role, s.op;

-- Even a non-superuser role holding explicit privileges is blocked by the trigger.
create role tests_audit_admin nologin bypassrls;  -- owner-ish: privileges + no RLS
grant usage on schema public to tests_audit_admin;
grant select, update, delete on public.audit_log to tests_audit_admin;
select is(tests.try_sql('tests_audit_admin', null, $s$update public.audit_log set action = 'x'$s$), 'err:42501',
  'L6.2 UPDATE blocked by trigger even with table privileges');
select is(tests.try_sql('tests_audit_admin', null, $s$delete from public.audit_log$s$), 'err:42501',
  'L6.2 DELETE blocked by trigger even with table privileges');

-- L6.3: hash chain.
select ok((select ok from public.audit_verify_chain()), 'L6.3 hash chain verifies');
select is((select count(*)::bigint from public.audit_log), (select checked from public.audit_verify_chain()),
  'L6.3 every row is checked');
select is(
  (select count(*)::int from (select a.prev_hash, lag(a.hash) over (order by a.seq) as prev from public.audit_log a) x
   where x.prev is not null and x.prev_hash <> x.prev), 0,
  'L6.3 each prev_hash equals the previous row hash');

-- Tamper as superuser (trigger disabled explicitly to simulate a privileged attacker).
alter table public.audit_log disable trigger audit_log_no_update_delete;
update public.audit_log set meta = '{"before": [], "after": ["+19990000000"]}'
 where action = 'relay_allowlist.update';
alter table public.audit_log enable trigger audit_log_no_update_delete;
select is((select ok from public.audit_verify_chain()), false, 'L6.3 tampered row breaks verification');
select is((select first_bad_seq from public.audit_verify_chain()),
  (select seq from public.audit_log where action = 'relay_allowlist.update'),
  'L6.3 verification points at the tampered row');

select * from finish();
rollback;
