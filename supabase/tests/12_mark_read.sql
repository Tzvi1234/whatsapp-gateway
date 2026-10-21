-- MCP mark_read on Baileys: session_commands 'mark_read' consumed by the worker.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

create temp table cmd on commit drop as
select tests.run_as('service_role', '{"role": "service_role"}',
  format($s$select public.request_mark_read(%L, '15550000009@s.whatsapp.net', array['WAIN0001', 'WAIN0002'])::text$s$,
    tests.id('acc_a')))::uuid as id;
select results_eq(
  format($s$select command, state, requested_via, payload from public.session_commands where id = %L$s$, (select id from cmd)),
  $s$values ('mark_read'::text, 'pending'::text, 'mcp'::text,
    '{"chat": "15550000009@s.whatsapp.net", "ids": ["WAIN0001", "WAIN0002"]}'::jsonb)$s$,
  'R3.1 mark_read becomes a pending worker command with chat + ids');
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select payload ->> 'chat' from public.session_commands where id = %L$s$, (select id from cmd))),
  '15550000009@s.whatsapp.net', 'R3.1 worker can read the command payload');
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_complete_session_command(%L, 'done', 'marked:2')::text$s$, (select id from cmd))),
  'true', 'R3.1 worker completes the command');

select throws_ok(format($s$select public.request_mark_read(%L, 'x@s.whatsapp.net', array['A'])$s$, tests.id('acc_a_cloud')),
  'P0002', null, 'R3.1 Cloud accounts use the Graph read receipt, not a worker command');
select throws_ok(format($s$select public.request_mark_read(%L, 'x@s.whatsapp.net', '{}'::text[])$s$, tests.id('acc_a')),
  '22023', null, 'R3.1 mark_read needs at least one id');
select throws_ok(format($s$insert into public.session_commands (org_id, account_id, command) values (%L, %L, 'mark_read')$s$,
  tests.id('org_a'), tests.id('acc_a')), '23514', null, 'R3.1 mark_read command without payload rejected by CHECK');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.request_mark_read(%L, 'x@s.whatsapp.net', array['A'])$s$, tests.id('acc_a'))), 'err:42501',
  'R3.1 only the server requests worker commands');

select * from finish();
rollback;
