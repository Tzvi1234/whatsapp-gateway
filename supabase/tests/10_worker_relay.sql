-- L4.6 worker-reported reply delivery failure, L3.4 transcript follow-up deliveries.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

create temp table fx on commit drop as
select b.batch_id, b.message_ids[1] as in_id from public.relay_batches b
 where b.relay_target_id = tests.id('target_a') limit 1;

-- Lia's reply: an outbound message on the Baileys account, linked to the batch.
create temp table reply on commit drop as
select message_id as id from public.enqueue_message(tests.id('acc_a'), '15550000009@s.whatsapp.net', 'text',
  'reply from Lia', p_use_case => 'agent_relay', p_idempotency_key => 'lia-reply-1',
  p_api_client_id => tests.id('api_a'));
update public.relay_batches set status = 'accepted', accepted_at = now() where batch_id = (select batch_id from fx);
select is(public.relay_mark_replied((select batch_id from fx), null, (select id from reply)), true,
  'L4.6 relay_mark_replied links the reply message');
select is((select reply_message_id from public.relay_batches where batch_id = (select batch_id from fx)),
  (select id from reply), 'L4.6 batch remembers its reply message');

-- Worker may not mark a non-failed message.
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_relay_delivery_failed(%L)::text$s$, (select id from reply))), 'err:55000',
  'L4.6 worker cannot report a message that did not fail');

update public.messages set status = 'failed', error_code = 'session_disconnected' where id = (select id from reply);
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_relay_delivery_failed(%L)::text$s$, (select id from reply))), 'true',
  'L4.6 worker reports the failed reply delivery');
select is((select status from public.relay_batches where batch_id = (select batch_id from fx)), 'delivery_failed',
  'L4.6 batch status delivery_failed');
select is((select count(*)::int from public.audit_log where action = 'relay.delivery_failed'), 1,
  'L4.6 delivery failure audited');
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_relay_delivery_failed(%L)::text$s$, (select in_id from fx))), 'err:P0002',
  'L4.6 worker cannot report inbound messages');
select is(tests.try_sql('authenticated', tests.claims('owner_a'),
  format($s$select public.worker_relay_delivery_failed(%L)$s$, (select id from reply))), 'err:42501',
  'L4.6 dashboard users cannot call the worker RPC');

-- L3.4: transcript follow-up.
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_relay_transcript_followup(%L, %L, 'late transcript') is not null$s$,
    (select batch_id from fx), (select in_id from fx))), 'true', 'L3.4 worker creates the follow-up');
select is((select count(*)::int from public.relay_followups where batch_id = (select batch_id from fx)), 1,
  'L3.4 idempotent per (batch, message): the fixture row is reused');
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_relay_transcript_followup(%L, %L, 'x')::text$s$,
    (select batch_id from fx), (select id from reply))), 'err:22023', 'L3.4 message must belong to the batch');
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_relay_transcript_followup(%L, %L, 'x')::text$s$,
    gen_random_uuid(), (select in_id from fx))), 'err:P0002', 'L3.4 unknown batch rejected');

-- Delivery ordering: the follow-up waits until its batch reached the receiver.
update public.relay_batches set status = null, lease_until = null where batch_id = (select batch_id from fx);
select is((select count(*)::int from public.claim_deliveries('d0', 50) where kind = 'relay_followup'), 0,
  'L3.4 follow-up is not delivered before its batch');
update public.relay_batches set status = 'replied' where batch_id = (select batch_id from fx);
select is(public.deliveries_due(), true, 'L3.4 follow-up makes deliveries due');
create temp table claimed on commit drop as
select * from public.claim_deliveries('d1', 50) where kind = 'relay_followup';
select is((select count(*)::int from claimed), 1, 'L3.4 follow-up claimed after the batch (even after Lia replied)');
select is((select count(*)::int from public.claim_deliveries('d2', 50) where kind = 'relay_followup'), 0,
  'L3.4 leased follow-up not re-claimed');
select is(public.relay_followup_delivery_result((select id from claimed), 503), 'failed', 'L3.4 5xx retried');
update public.relay_followups set next_attempt_at = now() - interval '1 second', lease_until = null;
select is(public.relay_followup_delivery_result((select id from claimed), 200), 'delivered', 'L3.4 2xx delivered');
select is(public.relay_followup_delivery_result((select id from claimed), 500), 'delivered',
  'L3.4 result is idempotent once delivered');

-- Retention: delivered follow-ups (they carry transcripts) are purged after 7 days.
update public.relay_followups set created_at = now() - interval '8 days';
select is(public.relay_followups_purge(), 1, 'S11 old delivered follow-ups purged');

-- Grants.
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.relay_followup_delivery_result(%L, 200)$s$, gen_random_uuid())), 'err:42501',
  'L3.4 only the server records follow-up results');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.relay_mark_delivery_failed(%L)$s$, (select batch_id from fx))), 'err:42501',
  'L4.6 service-role RPC stays closed to the worker');

select * from finish();
rollback;
