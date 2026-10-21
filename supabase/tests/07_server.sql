-- R5.1 lockout, L5.5 verification reset, S8 keys + rate limit, C5 vault, L4.x relay statuses.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

-- R5.1: 8 failures in 15 min per email+IP -> locked 15 min.
insert into public.login_attempts (email, ip, success, at)
select 'user@example.test', '203.0.113.5', false, now() - make_interval(mins => g) from generate_series(1, 7) g;
select is((select locked from public.login_check_lockout('user@example.test', '203.0.113.5')), false, 'R5.1 7 failures: not locked');
select public.login_record_attempt('USER@example.test', '203.0.113.5', false);
select results_eq($s$select locked, retry_after_seconds from public.login_check_lockout('user@example.test', '203.0.113.5')$s$,
  $s$values (true, 900)$s$, 'R5.1 8th failure locks for 15 min (email case-insensitive)');
select is((select locked from public.login_check_lockout('user@example.test', '203.0.113.6')), false,
  'R5.1 lock is per email+IP');
update public.login_attempts set at = at - interval '16 minutes' where email = 'user@example.test';
select is((select locked from public.login_check_lockout('user@example.test', '203.0.113.5')), false, 'R5.1 lock expires');
delete from public.login_attempts where email = 'user@example.test';
insert into public.login_attempts (email, ip, success, at)
select 'user@example.test', '203.0.113.5', false, now() - make_interval(mins => g * 3) from generate_series(1, 8) g;
select is((select locked from public.login_check_lockout('user@example.test', '203.0.113.5')), false,
  'R5.1 8 failures spread over 24 min do not lock');

-- L5.5: URL or key change resets last_verified_at.
select public.relay_record_test(tests.id('target_a'), '{"status": "accepted", "reason": "ok", "elapsed_ms": 10, "waiting": true}');
select is((select last_verified_at from public.relay_targets where id = tests.id('target_a')), null,
  'L5.3 accepted does not verify the channel');
select public.relay_record_test(tests.id('target_a'), '{"status": "replied", "reason": "ok", "elapsed_ms": 10}');
select isnt((select last_verified_at from public.relay_targets where id = tests.id('target_a')), null, 'L5.4 replied verifies');
select public.relay_set_target(tests.id('acc_a'), 'Lia', 'https://hooks.example.test/lia', 'sekret-key-abcd', 5000);
select isnt((select last_verified_at from public.relay_targets where id = tests.id('target_a')), null,
  'L5.5 unchanged URL and key keep verification');
select public.relay_set_target(tests.id('acc_a'), 'Lia', 'https://hooks.example.test/lia-v2');
select is((select last_verified_at from public.relay_targets where id = tests.id('target_a')), null, 'L5.5 URL change resets');
update public.relay_targets set last_verified_at = now() where id = tests.id('target_a');
select public.relay_set_target(tests.id('acc_a'), 'Lia', 'https://hooks.example.test/lia-v2', 'new-key-wxyz');
select is((select last_verified_at from public.relay_targets where id = tests.id('target_a')), null, 'L5.5 key change resets');
select is((select secret_last4 from public.relay_targets where id = tests.id('target_a')), 'wxyz', 'L5.6 key masked to last 4');
select is(public.vault_read_secret((select secret_vault_id from public.relay_targets where id = tests.id('target_a'))),
  'new-key-wxyz', 'C5 key lives in Vault');
select is((select count(*)::int from public.audit_log where action = 'relay_target.update'), 3, 'relay target changes audited');

-- C5 / vault wrappers callable only by service_role.
create temp table vs on commit drop as select tests.run_as('service_role', '{"role": "service_role"}',
  $s$select public.vault_store_secret('t1', 's3cret')::text$s$)::uuid as id;
select is(tests.run_as('service_role', '{"role": "service_role"}',
  format($s$select public.vault_read_secret(%L)$s$, (select id from vs))), 's3cret', 'C5 service_role vault roundtrip');
select is(tests.try_sql('authenticated', tests.claims('owner_a'), $s$select public.vault_store_secret('t2', 'x')$s$),
  'err:42501', 'C5 dashboard users cannot use vault RPCs');
select results_eq(
  $s$select access_token, app_secret, verify_token from public.provider_credentials_read(tests.id('acc_a_cloud'))$s$,
  $s$values ('EAAtesttoken1234'::text, 'appsecret5678'::text, 'verify9012'::text)$s$, 'C5 server reads plaintext via RPC only');

-- S8: API key lookup.
select is((select id from public.lookup_api_client('gw_test1')), tests.id('api_a'), 'S8 active key found by prefix');
select is(public.revoke_api_client(tests.id('api_a'), tests.id('owner_a')), true, 'S8 revoke');
select is((select count(*)::int from public.lookup_api_client('gw_test1')), 0, 'S8 revoked key rejected');
select public.create_api_client(tests.id('org_a'), 'old', 'gw_exp', repeat('c', 64), array['messages:send'], '{}', null, null,
  now() - interval '1 day');
select is((select count(*)::int from public.lookup_api_client('gw_exp')), 0, 'S8 expired key rejected');

-- Rate limit token bucket.
create function pg_temp.take_n(n int) returns int language plpgsql as $f$
declare ok int := 0; begin
  for i in 1..n loop
    if (select allowed from public.rate_limit_take('k1', 3, 0.01)) then ok := ok + 1; end if;
  end loop; return ok; end $f$;
select is(pg_temp.take_n(5), 3, 'S8 bucket of 3 allows 3 of 5 rapid calls');
select results_eq($s$select allowed, retry_after_ms > 0 and retry_after_ms <= 100000 from public.rate_limit_take('k1', 3, 0.01)$s$,
  $s$values (false, true)$s$, 'S8 4th call -> 429 with retry_after');
update public.rate_limit_buckets set updated_at = updated_at - interval '200 seconds' where key = 'k1';
select is((select allowed from public.rate_limit_take('k1', 3, 0.01)), true, 'S8 refills over time');

-- Relay delivery statuses (L4.x) through the deliverer RPCs.
create temp table b on commit drop as select batch_id from public.relay_batches limit 1;
select is((select count(*)::int from public.claim_deliveries('d1', 10) where kind = 'relay'), 1, 'relay batch claimable');
select is((select count(*)::int from public.claim_deliveries('d2', 10) where kind = 'relay'), 0, 'leased batch not re-claimed');
select is(public.relay_batch_delivery_result((select batch_id from b), 503), 'retry', 'L4.5 5xx retried');
update public.relay_batches set attempts = max_attempts - 1;
select is(public.relay_batch_delivery_result((select batch_id from b), 0, 'timeout'), 'unreachable',
  'L4.5 network error after retries -> unreachable');
select is((select count(*)::int from public.alerts where kind = 'relay_unreachable'), 1, 'unreachable alerted');
select is(public.relay_resend_batch((select batch_id from b)), true, 'L4.8 resend keeps the batch_id');
select is(public.relay_batch_delivery_result((select batch_id from b), 401), 'rejected_key', 'L4.4 401 -> rejected_key');
select public.relay_resend_batch((select batch_id from b));
select is(public.relay_batch_delivery_result((select batch_id from b), 202), 'accepted', 'L4.1 2xx -> accepted');
select is(public.relay_batch_delivery_result((select batch_id from b), 202), 'accepted', 'result is idempotent');
update public.relay_batches set accepted_at = now() - interval '9 minutes';
select is(public.relay_evaluate_no_reply(), 0, 'L4.2 still accepted before the threshold');
update public.relay_batches set accepted_at = now() - interval '11 minutes';
select is(public.relay_evaluate_no_reply(), 1, 'L4.3 no reply after 10 min -> no_reply');
select is((select status from public.relay_batches), 'no_reply', 'status no_reply');
select is((select count(*)::int from public.alerts where kind = 'relay_no_reply' and resolved_at is null), 1, 'L4.3 alert');
select is(public.relay_mark_replied((select batch_id from b)), true, 'late reply counts');
select results_eq($s$select status, first_response_at is not null, replied_at is not null from public.relay_batches$s$,
  $s$values ('replied'::text, true, true)$s$, 'L4.1 replied with first_response_at');
select is((select count(*)::int from public.alerts where kind = 'relay_no_reply' and resolved_at is null), 0, 'alert resolved');
select is(public.relay_mark_delivery_failed((select batch_id from b)), true, 'L4.6 delivery_failed');

-- Generic webhook deliveries: retry then dead.
create temp table wd on commit drop as select id from public.webhook_deliveries limit 1;
select is(public.webhook_delivery_result((select id from wd), 500, 'boom'), 'failed', 'webhook retry scheduled');
select ok((select next_attempt_at between now() + interval '8 seconds' and now() + interval '12 seconds'
           from public.webhook_deliveries where id = (select id from wd)), 'first webhook retry after ~10 s (jitter)');
update public.webhook_deliveries set attempt = 5 where id = (select id from wd);
select is(public.webhook_delivery_result((select id from wd), 500), 'dead', 'webhook dead after 6 attempts');
select is((select count(*)::int from public.alerts where kind = 'webhook_failing'), 1, 'webhook failure alerted');

-- Edge invocation: configured via Vault -> pg_net request with the cron secret header.
select public.vault_store_secret('edge_base_url', 'https://example-ref.supabase.co/functions/v1/');
select public.vault_store_secret('edge_cron_secret', 'cron-secret-test');
select isnt(public.invoke_edge_function('heartbeat-alert'), null, 'R4.8/RL5 cron -> Edge Function call queued');
select ok(to_regclass('net.http_request_queue') is null or exists (
  select 1 from net.http_request_queue where url = 'https://example-ref.supabase.co/functions/v1/heartbeat-alert'
    and headers ->> 'x-cron-secret' = 'cron-secret-test'), 'request targets the function with the secret header');
select is((select count(*)::int from cron.job where jobname like 'gw-%' and schedule = '* * * * *'), 6,
  'R4.8 / RL5 six every-minute jobs scheduled (incl. gw-reminders)');

select * from finish();
rollback;
