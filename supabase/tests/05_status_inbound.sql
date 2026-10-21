-- R4.7 forward-only status ranking; inbound ingest idempotency + 24h window.
begin;
set local client_min_messages = warning;
select plan(15);
select tests.create_fixture();

create temp table ctx (k text primary key, v uuid) on commit drop;
insert into ctx select 'm', message_id from public.enqueue_message(tests.id('acc_a_cloud'), '15550000009', 'text', 'x',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-status');
select public.message_record_send_result((select v from ctx), 'wamid.S1');
create function pg_temp.st() returns text language sql as $$
  select status from public.messages where id = (select v from ctx) $$;

-- R4.7: delivered before sent; failed after read.
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'delivered'), true, 'R4.7 sent -> delivered');
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'sent'), false, 'R4.7 late "sent" ignored');
select is(pg_temp.st(), 'delivered', 'R4.7 status stays delivered');
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'read'), true, 'R4.7 delivered -> read');
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'delivered'), false, 'R4.7 late "delivered" ignored');
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'failed', null, 'provider_error'), true,
  'R4.7 failed wins even after read');
select is(pg_temp.st(), 'failed', 'R4.7 status is failed');
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'read'), false, 'R4.7 failed is terminal');
select is(public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.UNKNOWN', 'read'), false, 'unknown id is a no-op');
select throws_ok($s$select public.apply_message_status(tests.id('acc_a_cloud'), 'wamid.S1', 'bogus')$s$, '22023', null,
  'invalid status rejected');

-- Inbound idempotency on (account_id, provider_message_id).
select is((select created from public.ingest_inbound(tests.id('acc_a'), 'WAIN0001', '15550000009@s.whatsapp.net', 'text', 'dup')),
  false, 'duplicate inbound returns created=false');
select is((select count(*)::int from public.messages where account_id = tests.id('acc_a') and provider_message_id = 'WAIN0001'), 1,
  'one row per (account, provider id)');
select is((select body from public.messages where provider_message_id = 'WAIN0001'), 'hello', 'original kept');
select ok((select last_inbound_at is not null from public.conversations
           where account_id = tests.id('acc_a') and chat_jid = '15550000009@s.whatsapp.net'),
  'R4.1 inbound updates conversations.last_inbound_at (24h window)');
select is((select count(*)::int from public.webhook_deliveries where event = 'message.received'), 1,
  'message.received fan-out to the subscribed endpoint');

select * from finish();
rollback;
