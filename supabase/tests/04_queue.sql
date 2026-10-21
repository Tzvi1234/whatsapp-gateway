-- Queue semantics (ARCH §8.1, §8.2): claim_jobs FIFO + SKIP LOCKED + lease reclaim,
-- RL2 idempotent completion / no double send, fail_job backoff + dead letter, R3.5 idempotency.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

create temp table ctx (k text primary key, v uuid) on commit drop;
insert into ctx select 'm1', id from public.messages where idempotency_key = 'k-1';
insert into ctx select 'm2', message_id from public.enqueue_message(tests.id('acc_a'), '15550000009@s.whatsapp.net', 'text', 'two',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-2');
insert into ctx select 'm3', message_id from public.enqueue_message(tests.id('acc_a'), '15550000009@s.whatsapp.net', 'text', 'three',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-3');
insert into ctx select 'm4', message_id from public.enqueue_message(tests.id('acc_a'), '15550000777@s.whatsapp.net', 'text', 'other chat',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-4');
create function pg_temp.c(p text) returns uuid language sql as $$ select v from ctx where k = p $$;
create function pg_temp.job(p text) returns uuid language sql as $$
  select q.id from public.outbound_queue q where q.message_id = pg_temp.c(p) order by q.created_at desc limit 1 $$;

-- R3.5 idempotency (sequential duplicate).
select results_eq(
  $s$select message_id, created from public.enqueue_message(tests.id('acc_a'), '15550000009@s.whatsapp.net', 'text', 'two again',
       p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-2')$s$,
  $s$select pg_temp.c('m2'), false$s$,
  'R3.5 duplicate idempotency key returns the existing message, created=false');
select is((select count(*)::int from public.outbound_queue where message_id = pg_temp.c('m2')), 1,
  'R3.5 duplicate creates no second job');
select is((select count(*)::int from public.messages where idempotency_key = 'k-2'), 1, 'R3.5 one message row');
select throws_ok(
  $s$select * from public.enqueue_message(tests.id('acc_a_cloud'), '15550000009', 'text', 'x', p_executor => 'worker')$s$,
  '22023', null, 'executor must match the account provider');

-- FIFO: only the oldest unfinished job per conversation is claimable.
create temp table claim1 on commit drop as select * from public.claim_jobs('w1', 'worker', 10);
select set_eq('select message_id from claim1', $s$values (pg_temp.c('m1')), (pg_temp.c('m4'))$s$,
  'RL3 claim returns only the oldest job per conversation (m1, m4), not m2/m3');
select is((select lease_until from claim1 limit 1), now() + interval '60 seconds', 'lease is 60 s');
select is((select status from public.messages where id = pg_temp.c('m1')), 'sending', 'claimed message is sending');
select is((select count(*)::int from public.claim_jobs('w2', 'worker', 10)), 0,
  'RL3 second claimer gets nothing while the head of each conversation is leased');
select is((select count(*)::int from public.claim_jobs('w2', 'edge', 10)), 0, 'executors are separate');

-- RL2: complete_job is idempotent.
select is(public.complete_job(pg_temp.job('m1'), 'WA-1'), true, 'RL2 first complete_job completes');
select is(public.complete_job(pg_temp.job('m1'), 'WA-1-dup'), false, 'RL2 second complete_job is a no-op');
select results_eq(
  $s$select status, provider_message_id from public.messages where id = pg_temp.c('m1')$s$,
  $s$values ('sent'::text, 'WA-1'::text)$s$, 'RL2 message sent once with the first provider id');

-- Next job of the conversation becomes claimable.
select set_eq($s$select message_id from public.claim_jobs('w1', 'worker', 10)$s$, $s$values (pg_temp.c('m2'))$s$,
  'RL3 after completion the next job of the conversation is claimable');

-- Lease reclaim after a crash.
update public.outbound_queue set lease_until = now() - interval '1 second' where id = pg_temp.job('m2');
create temp table claim2 on commit drop as select * from public.claim_jobs('w2', 'worker', 10);
select results_eq($s$select message_id, attempts from claim2$s$, $s$values (pg_temp.c('m2'), 2)$s$,
  'RL2 expired lease is reclaimed by another worker (attempt 2)');
select is(public.renew_lease(pg_temp.job('m2'), 'w1'), null, 'renew_lease fails for the worker that lost the lease');
select isnt(public.renew_lease(pg_temp.job('m2'), 'w2'), null, 'renew_lease succeeds for the lease holder');
-- The crashed worker had actually sent: its late completion wins, the second one is a no-op.
select is(public.complete_job(pg_temp.job('m2'), 'WA-2'), true, 'RL2 late completion by the crashed worker');
select is(public.complete_job(pg_temp.job('m2'), 'WA-2-second'), false, 'RL2 re-claimer completion is a no-op');
select is((select provider_message_id from public.messages where id = pg_temp.c('m2')), 'WA-2', 'RL2 no double send recorded');

-- Reserved provider id survives a crash so the re-claimer does not resend.
select set_eq($s$select message_id from public.claim_jobs('w2', 'worker', 10)$s$, $s$values (pg_temp.c('m3'))$s$,
  'm3 claimed');
select is(public.job_reserve_provider_id(pg_temp.job('m3'), 'w2', 'WA-3'), true, 'RL2 provider id reserved before send');
update public.outbound_queue set lease_until = now() - interval '1 second' where id = pg_temp.job('m3');
select is((select provider_message_id from public.claim_jobs('w3', 'worker', 10) where message_id = pg_temp.c('m3')), 'WA-3',
  'RL2 re-claimed job carries the reserved provider id (worker completes instead of resending)');
select is(public.complete_job(pg_temp.job('m3'), 'WA-3'), true, 'RL2 completion with the reserved id');
select is((select status from public.messages where id = pg_temp.c('m3')), 'sent', 'm3 sent');

-- fail_job: transient backoff 5s, 30s, 2m, 10m, 15m; then dead + alert.
select is(public.fail_job(pg_temp.job('m4'), 'network', true), 'ready', 'R4.5 transient failure schedules a retry');
select is((select run_at from public.outbound_queue where id = pg_temp.job('m4')), now() + interval '5 seconds',
  'R4.5 first retry after 5 s');
select is((select status from public.messages where id = pg_temp.c('m4')), 'queued', 'message back to queued');
-- Drive attempts 2..5 explicitly.
create function pg_temp.fail_at(p_attempt int) returns interval language plpgsql as $$
begin
  update public.outbound_queue set state = 'leased', attempts = p_attempt, lease_owner = 'w1'
   where id = pg_temp.job('m4');
  perform public.fail_job(pg_temp.job('m4'), 'network', true);
  return (select run_at - now() from public.outbound_queue where id = pg_temp.job('m4'));
end $$;
select is(pg_temp.fail_at(2), interval '30 seconds', 'R4.5 second retry after 30 s');
select is(pg_temp.fail_at(3), interval '2 minutes', 'R4.5 third retry after 2 min');
select is(pg_temp.fail_at(4), interval '10 minutes', 'R4.5 fourth retry after 10 min');
select is(pg_temp.fail_at(5), interval '15 minutes', 'R4.5 fifth retry after 15 min');
update public.outbound_queue set state = 'leased', attempts = 6 where id = pg_temp.job('m4');
select is(public.fail_job(pg_temp.job('m4'), 'network', true), 'dead', 'R4.5 exhausted retries -> dead');
select is((select status from public.messages where id = pg_temp.c('m4')), 'failed', 'dead job -> message failed');
select is((select count(*)::int from public.alerts where kind = 'dead_letter' and ref_id = pg_temp.job('m4')::text), 1,
  'R4.5 dead letter raises one alert');
select is(public.fail_job(pg_temp.job('m4'), 'network', true), 'dead', 'fail_job on a dead job is a no-op');

-- Permanent failure: dead at once, no alert. Then Resend.
insert into ctx select 'm5', message_id from public.enqueue_message(tests.id('acc_a'), '15550000555@s.whatsapp.net', 'text', 'p',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-5');
select is((select count(*)::int from public.claim_jobs('w1', 'worker', 10) where message_id = pg_temp.c('m5')), 1,
  'm5 claimed');
select is(public.fail_job(pg_temp.job('m5'), 'invalid_number', false), 'dead', 'permanent failure -> dead immediately');
select is((select error_code from public.messages where id = pg_temp.c('m5')), 'invalid_number', 'reason recorded');
select is((select count(*)::int from public.alerts where ref_id = pg_temp.job('m5')::text), 0, 'no alert for permanent failure');
select isnt(public.message_requeue(pg_temp.c('m5')), null, 'Resend creates a new attempt');
select is((select status from public.messages where id = pg_temp.c('m5')), 'queued', 'resent message is queued again');

-- Cloud direct send result -> edge retry job.
insert into ctx select 'c1', message_id from public.enqueue_message(tests.id('acc_a_cloud'), '15550000009', 'text', 'cloud',
  p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-c1');
select is((select count(*)::int from public.outbound_queue where message_id = pg_temp.c('c1')), 0,
  'Cloud send: no job before the direct attempt');
select is(public.message_record_send_result(pg_temp.c('c1'), null, 'network', true), 'queued',
  'R4.5 transient Graph error -> queued for edge retry');
select results_eq($s$select executor, attempts, run_at from public.outbound_queue where message_id = pg_temp.c('c1')$s$,
  $s$values ('edge'::text, 1, now() + interval '5 seconds')$s$, 'edge job: attempt 1 done, retry in 5 s');
select is(public.edge_jobs_due(), false, 'R4.8 nothing due yet');
update public.outbound_queue set run_at = now() - interval '1 second' where message_id = pg_temp.c('c1');
select is(public.edge_jobs_due(), true, 'R4.8 due job detected by the cron probe');
select is((select message_id from public.claim_jobs('edge:cloud-retry', 'edge', 5)), pg_temp.c('c1'),
  'R4.8 edge executor claims the Cloud job');
select is(public.message_record_send_result(pg_temp.c('c1'), 'wamid.X'), 'sent', 'successful send recorded');

select * from finish();
rollback;
