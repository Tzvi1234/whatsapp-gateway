-- R4.1-R4.6, R4.8: reminder dispatcher state machine (the send itself runs on Vercel through the gate).
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

-- Idempotent create (MCP client_msg_id).
create temp table r1 on commit drop as
select * from public.reminder_create(tests.id('acc_a_cloud'), '+15550000009', now() - interval '1 minute',
  'tomorrow 9:00', p_api_client_id => tests.id('api_a'), p_client_reminder_id => 'rem-1');
select is((select created from r1), true, 'R3.5 first send_reminder creates');
select results_eq($s$select reminder_id, created from public.reminder_create(tests.id('acc_a_cloud'), '+15550000009',
    now(), 'other text', p_api_client_id => tests.id('api_a'), p_client_reminder_id => 'rem-1')$s$,
  $s$select reminder_id, false from r1$s$, 'R3.5 same client id → same reminder, duplicate');
select is((select state from public.reminders where id = (select reminder_id from r1)), 'scheduled',
  'R4.1 configured Cloud account → scheduled');
select throws_ok(format($s$select * from public.reminder_create(%L, '+15550000009', now())$s$, tests.id('acc_a_cloud')),
  '22023', null, 'reminder needs text or template');

-- R4.8: cron job exists and runs every minute.
select is((select schedule from cron.job where jobname = 'gw-reminders'), '* * * * *', 'R4.8 gw-reminders every minute');

-- Claim → sending, leased; not claimable twice.
select is(public.reminders_dispatch_due() >= 1, true, 'R4.8 due reminders counted (Edge Function invoked)');
create temp table c1 on commit drop as select * from public.reminders_claim_due('edge:test', 50);
select is((select count(*)::int from c1 where reminder_id = (select reminder_id from r1)), 1, 'due reminder claimed');
select is((select state from public.reminders where id = (select reminder_id from r1)), 'sending', 'claimed → sending');
select is((select count(*)::int from public.reminders_claim_due('edge:other', 50) where reminder_id = (select reminder_id from r1)),
  0, 'leased reminder not re-claimed');

-- R4.6: cannot cancel while dispatching / after send.
select throws_ok(format($s$select public.reminder_cancel(%L, %L)$s$, (select reminder_id from r1), tests.id('acc_a_cloud')),
  '55000', null, 'R4.6 cancel while sending rejected');

-- Linked to its message; then follows the message status.
create temp table m1 on commit drop as
select message_id as id from public.enqueue_message(tests.id('acc_a_cloud'), '15550000009', 'text', 'tomorrow 9:00',
  p_use_case => 'reminders', p_idempotency_key => 'reminder:' || (select reminder_id from r1));
select is(public.reminder_record_dispatch((select reminder_id from r1), (select id from m1)), 'queued',
  'R4.1 dispatch links the message (state = message status)');
select is((select attempts from public.reminders where id = (select reminder_id from r1)), 1, 'one attempt used');
select public.message_record_send_result((select id from m1), 'wamid.REM1');
select is((select state from public.reminders where id = (select reminder_id from r1)), 'sent', 'R4.1 reminder follows message → sent');
select public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.REM1', 'delivered');
select is((select state from public.reminders where id = (select reminder_id from r1)), 'delivered', 'reminder → delivered');
select is(public.reminder_record_dispatch((select reminder_id from r1), null, 'internal'), 'delivered',
  'late duplicate dispatch result is a no-op');
select throws_ok(format($s$select public.reminder_cancel(%L, %L)$s$, (select reminder_id from r1), tests.id('acc_a_cloud')),
  '55000', 'reminder_already_delivered', 'R4.6 cancel after send rejected with a clear reason');

-- R4.2: gate rejection recorded with its reason.
create temp table r2 on commit drop as
select * from public.reminder_create(tests.id('acc_a_cloud'), '+15550000008', now() - interval '1 minute', 'late');
select count(*) from public.reminders_claim_due('edge:test', 50);
select is(public.reminder_record_dispatch((select reminder_id from r2), null, 'outside_24h_window', 'use send_template'),
  'failed', 'R4.2 outside the window without a template → failed');
select results_eq(format($s$select error_code, error_detail from public.reminders where id = %L$s$, (select reminder_id from r2)),
  $s$values ('outside_24h_window'::text, 'use send_template'::text)$s$, 'R4.2 clear reason stored');

-- R4.4: missing credentials → unconfigured without using attempts; back to scheduled once added.
update public.provider_credentials set vault_secret_id = null where account_id = tests.id('acc_a_cloud');
create temp table r3 on commit drop as
select * from public.reminder_create(tests.id('acc_a_cloud'), '+15550000007', now() - interval '1 minute', 'x');
select is((select state from public.reminders where id = (select reminder_id from r3)), 'unconfigured',
  'R4.4 created unconfigured when credentials are missing');
select public.reminders_dispatch_due();
select public.reminders_dispatch_due();
select results_eq(format($s$select state, attempts from public.reminders where id = %L$s$, (select reminder_id from r3)),
  $s$values ('unconfigured'::text, 0)$s$, 'R4.4 retried every minute without using attempts');
select is((select count(*)::int from public.reminders_claim_due('edge:test', 50) where reminder_id = (select reminder_id from r3)),
  0, 'R4.4 unconfigured reminder never claimed');
-- A dispatch that discovers missing credentials does not use an attempt either.
update public.reminders set state = 'sending', lease_until = now() + interval '1 minute' where id = (select reminder_id from r3);
select is(public.reminder_record_dispatch((select reminder_id from r3), p_unconfigured => true), 'unconfigured',
  'R4.4 dispatcher reports unconfigured');
select is((select attempts from public.reminders where id = (select reminder_id from r3)), 0, 'R4.4 still no attempt used');
select public.provider_credentials_upsert(tests.id('acc_a_cloud'), p_access_token => 'EAAnewtoken9999');
select public.reminders_dispatch_due();
select is((select state from public.reminders where id = (select reminder_id from r3)), 'scheduled',
  'R4.4 credentials added → scheduled again');
select is((select count(*)::int from public.reminders_claim_due('edge:test', 50) where reminder_id = (select reminder_id from r3)),
  1, 'R4.4 sent automatically on the next run');

-- Expired dispatch lease without a linked message is re-claimed.
update public.reminders set lease_until = now() - interval '1 second' where id = (select reminder_id from r3);
select is((select count(*)::int from public.reminders_claim_due('edge:test2', 50) where reminder_id = (select reminder_id from r3)),
  1, 'crashed dispatch is re-claimed (enqueue is idempotent on reminder:<id>)');

-- R4.6: cancel before send.
create temp table r4 on commit drop as
select * from public.reminder_create(tests.id('acc_a'), '+15550000006', now() + interval '1 day', 'later');
select is(public.reminder_cancel((select reminder_id from r4), tests.id('acc_a')), 'cancelled', 'R4.6 cancel before send');
select throws_ok(format($s$select public.reminder_cancel(%L, %L)$s$, (select reminder_id from r4), tests.id('acc_a_cloud')),
  'P0002', null, 'cancel is scoped to the account');

-- Grants.
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}', $s$select public.reminders_claim_due('w', 1)$s$),
  'err:42501', 'S13 the worker cannot claim reminders (dispatch runs through the server gate)');
select is(tests.try_sql('authenticated', tests.claims('owner_a'), $s$select public.reminders_dispatch_due()$s$),
  'err:42501', 'dashboard users cannot run the dispatcher');

select * from finish();
rollback;
