-- RL2: reserved-but-unconfirmed Baileys ids (pre-generated message id).
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

create temp table m on commit drop as
select message_id as id from public.enqueue_message(tests.id('acc_a'), '15550000777@s.whatsapp.net', 'text', 'r',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-rl2');
create temp table j on commit drop as
select job_id as id from public.claim_jobs('w1', 'worker', 50) where message_id = (select id from m);
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.job_reserve_provider_id(%L, 'w1', '3EB0RESERVED')::text$s$, (select id from j))), 'true',
  'RL2 worker reserves the pre-generated id before sending');
select is(public.job_reserve_provider_id((select id from j), 'w1', '3EB0OTHER'), false,
  'RL2 a second, different reservation is refused');
select is(public.fail_job((select id from j), 'invalid_number', false), 'dead', 'RL2 permanent failure after reserve');
select isnt(public.message_requeue((select id from m)), null,
  'RL2 Resend allowed: the reserved id was never confirmed sent');
select is((select provider_message_id from public.claim_jobs('w2', 'worker', 50) where message_id = (select id from m)),
  '3EB0RESERVED', 'RL2 re-claimed job carries the SAME reserved id (worker resends with it or completes)');
select is((select public.complete_job(q.id, '3EB0RESERVED') from public.outbound_queue q
            where q.message_id = (select id from m) and q.state = 'leased'), true, 'RL2 completion with the reserved id');
select is((select status from public.messages where id = (select id from m)), 'sent', 'RL2 message sent once');

-- A confirmed send can never be resent.
update public.messages set status = 'failed' where id = (select id from m);
select throws_ok(format($s$select public.message_requeue(%L)$s$, (select id from m)), '55000', null,
  'RL2 confirmed (sent_at) messages are not resendable');

select * from finish();
rollback;
