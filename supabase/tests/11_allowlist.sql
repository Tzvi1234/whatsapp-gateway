-- L6.1 / L2.1: the send gate's sender_allowlist is derived from the relay target (single source).
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

select is((select use_case_policy -> 'sender_allowlist' from public.accounts where id = tests.id('acc_a')),
  '[]'::jsonb, 'L6.1 empty relay allowlist → empty gate allowlist');
select is((select (use_case_policy ->> 'relay')::boolean from public.accounts where id = tests.id('acc_a')), true,
  'L2.1 enabled relay target turns relay on');
select ok((select use_case_policy -> 'allowed_use_cases' ? 'agent_relay' from public.accounts where id = tests.id('acc_a')),
  'L2.1 enabled relay target allows agent_relay');

select public.relay_allowlist_update(tests.id('target_a'), array['+15550000009', '+15550000008', '+15550000009'],
  tests.id('owner_a'), true);
select is((select use_case_policy -> 'sender_allowlist' from public.accounts where id = tests.id('acc_a')),
  '["+15550000008", "+15550000009"]'::jsonb, 'L6.1 allowlist update is reflected in the gate policy');
select is((select count(*)::int from public.audit_log where action = 'relay_allowlist.update'), 1,
  'L6.1 allowlist change audited');

-- Direct writes cannot bypass the audited RPC.
select throws_ok(format($s$update public.relay_targets set allowed_senders = array['+15550000007'] where id = %L$s$,
  tests.id('target_a')), '42501', null, 'L6.1 direct allowed_senders update rejected');
select is(tests.try_sql('service_role', '{"role": "service_role"}',
  format($s$update public.relay_targets set allowed_senders = array['+15550000007'] where id = %L$s$,
  tests.id('target_a'))), 'err:42501', 'L6.1 not even service_role bypasses relay_allowlist_update');
select throws_ok(format($s$insert into public.relay_targets (org_id, account_id, name, url, allowed_senders)
  values (%L, %L, 'Other', 'https://hooks.example.test/x', array['+15550000007'])$s$,
  tests.id('org_a'), tests.id('acc_a')), '42501', null, 'L6.1 new target cannot start with a direct allowlist');

-- The account policy cannot carry a different allowlist.
update public.accounts
   set use_case_policy = use_case_policy || '{"sender_allowlist": ["+15550000001"]}'::jsonb
 where id = tests.id('acc_a');
select is((select use_case_policy -> 'sender_allowlist' from public.accounts where id = tests.id('acc_a')),
  '["+15550000008", "+15550000009"]'::jsonb, 'L6.1 direct policy write keeps the derived allowlist');

-- Disabling the channel empties the gate allowlist (fail closed for agent_relay).
update public.relay_targets set enabled = false where id = tests.id('target_a');
select is((select use_case_policy -> 'sender_allowlist' from public.accounts where id = tests.id('acc_a')),
  '[]'::jsonb, 'L2.1 disabled relay target → empty gate allowlist');
update public.relay_targets set enabled = true where id = tests.id('target_a');
select is((select use_case_policy -> 'sender_allowlist' from public.accounts where id = tests.id('acc_a')),
  '["+15550000008", "+15550000009"]'::jsonb, 'L2.1 re-enabled target restores it');

-- Accounts without a relay target: empty allowlist, relay flag untouched.
select is((select use_case_policy -> 'sender_allowlist' from public.accounts where id = tests.id('acc_a_cloud')),
  '[]'::jsonb, 'L6.1 account without relay target has no allowlist');
select is((select use_case_policy ? 'relay' from public.accounts where id = tests.id('acc_a_cloud')), false,
  'L6.1 non-relay account keeps its policy shape');

-- Constraint still reports bad numbers through the RPC.
select throws_ok(format($s$select public.relay_allowlist_update(%L, array['0559014410'], %L, true)$s$,
  tests.id('target_a'), tests.id('owner_a')), '23514', null, 'L6.1 RPC still enforces E.164');

select * from finish();
rollback;
