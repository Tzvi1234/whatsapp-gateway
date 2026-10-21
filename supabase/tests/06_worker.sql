-- S5 single writer, RL5 heartbeat state machine, R5.3 pairing purge, session events, worker RPCs.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

-- S5: advisory-lock-guarded lease per account.
select is(public.worker_try_lock_account(tests.id('acc_a'), 'worker-1'), true, 'S5 first worker gets the account');
select is(public.worker_try_lock_account(tests.id('acc_a'), 'worker-2'), false, 'S5 second worker never opens the session');
select is(public.worker_try_lock_account(tests.id('acc_a'), 'worker-1'), true, 'S5 holder can renew');
select throws_ok($s$select public.worker_session_event(tests.id('acc_a'), 'worker-2', 'open')$s$, '55P03', null,
  'S5 non-holder cannot write session events');
update public.sessions set lock_until = now() - interval '1 second' where account_id = tests.id('acc_a');
select is(public.worker_try_lock_account(tests.id('acc_a'), 'worker-2'), true, 'S5 expired lease can be taken over');
select is(public.worker_try_lock_account(tests.id('acc_a'), 'worker-1'), false, 'S5 old holder is now locked out');
select is(public.worker_unlock_account(tests.id('acc_a'), 'worker-2'), true, 'S5 holder releases');
select is(tests.run_as('gateway_worker', '{"role": "gateway_worker"}',
  format($s$select public.worker_try_lock_account(%L, 'worker-3')::text$s$, tests.id('acc_a'))), 'true',
  'S5 lock RPC callable as gateway_worker');

-- Session events -> sessions/accounts + P1 alert.
select isnt(public.worker_session_event(tests.id('acc_a'), 'worker-3', 'logged_out', '401'), null, 'RL4 logged_out recorded');
select results_eq($s$select connection from public.sessions where account_id = tests.id('acc_a')$s$,
  $s$values ('needs_relink'::text)$s$, 'RL4 loggedOut -> needs_relink');
select is((select count(*)::int from public.alerts where account_id = tests.id('acc_a') and kind = 'needs_relink'
           and severity = 'P1' and resolved_at is null), 1, 'RL4 P1 alert raised');
select isnt(public.worker_session_event(tests.id('acc_a'), 'worker-3', 'open'), null, 'reopened');
select is((select count(*)::int from public.alerts where account_id = tests.id('acc_a') and kind = 'needs_relink'
           and resolved_at is null), 0, 'alert resolved on reconnect');
select ok((select count(*) > 0 from public.v_session_lifetime where account_id = tests.id('acc_a')), 'session lifetime metric');
select ok((select count(*) > 0 from public.v_reconnect_time where account_id = tests.id('acc_a')), 'reconnect time metric');

-- RL5 heartbeat: stale > 3 min -> exactly one "down", then exactly one "recovered" with duration.
update public.heartbeat_state set last_seen_at = now() - interval '2 minutes' where worker_id = 'worker-a';
select is((select count(*)::int from public.heartbeat_evaluate()), 0, 'RL5 2 min silence is not down');
update public.heartbeat_state set last_seen_at = now() - interval '4 minutes' where worker_id = 'worker-a';
select is((select count(*)::int from public.heartbeat_evaluate()), 1, 'RL5 >3 min silence -> down');
select is((select count(*)::int from public.heartbeat_evaluate()), 0, 'RL5 repeated checks do not re-open the outage');
create temp table n1 on commit drop as select * from public.heartbeat_claim_notifications();
select results_eq($s$select worker_id, kind from n1$s$, $s$values ('worker-a'::text, 'down'::text)$s$,
  'RL5 one "down" notification owed');
select is((select count(*)::int from public.heartbeat_claim_notifications()), 0, 'RL5 claimed notification is leased (no double send)');
select is(public.heartbeat_ack_notification((select interval_id from n1), 'down'), true, 'RL5 down mail acked');
select is(public.heartbeat_ack_notification((select interval_id from n1), 'down'), false, 'RL5 second ack is a no-op');
update public.downtime_intervals set notify_lease_until = null;
select is((select count(*)::int from public.heartbeat_claim_notifications()), 0, 'RL5 no repeat "down" mail');
select is((select count(*)::int from public.alerts where kind = 'worker_down' and resolved_at is null), 1, 'RL5 P1 alert open');
select public.record_heartbeat(tests.id('org_a'), 'worker-a', '0.0.1', '7.0.0-rc14', '[]');
create temp table n2 on commit drop as select * from public.heartbeat_claim_notifications();
select results_eq($s$select kind, duration_seconds from n2$s$, $s$values ('recovered'::text, 240::bigint)$s$,
  'RL5 one "recovered" notification with downtime duration');
select is(public.heartbeat_ack_notification((select interval_id from n2), 'recovered'), true, 'RL5 recovered mail acked');
update public.downtime_intervals set notify_lease_until = null;
select is((select count(*)::int from public.heartbeat_claim_notifications()), 0, 'RL5 nothing more to send');
select results_eq($s$select ended_at - started_at from public.downtime_intervals where id = (select interval_id from n2)$s$,
  $s$values (interval '4 minutes')$s$, 'RL5 downtime interval recorded');
select is((select count(*)::int from public.alerts where kind = 'worker_down' and resolved_at is null), 0, 'RL5 alert resolved');

-- R5.3 pairing: QR <= 60 s, purge on success and expiry.
create temp table pr on commit drop as
  select public.create_pairing_request(tests.id('acc_a'), tests.id('owner_a'), 'qr', null, null) as id;
select is((select count(*)::int from public.pairing_qr where account_id = tests.id('acc_a')), 0,
  'new request clears previous QR rows');
select isnt(public.worker_pairing_qr_upsert((select id from pr), 'worker-3', 'QR-1', null, 300), null, 'QR stored');
select ok((select expires_at <= created_at + interval '60 seconds' from public.pairing_qr where request_id = (select id from pr)),
  'R5.3 QR TTL capped at 60 s');
select throws_ok(
  format($s$insert into public.pairing_qr (org_id, request_id, account_id, qr, expires_at)
            values (%L, gen_random_uuid(), %L, 'x', now() + interval '5 minutes')$s$, tests.id('org_a'), tests.id('acc_a')),
  '23514', null, 'R5.3 QR row with TTL > 60 s rejected');
select is(public.worker_pairing_finish((select id from pr), 'worker-3', 'paired', '+15550000001'), true, 'pairing finished');
select is((select count(*)::int from public.pairing_qr where request_id = (select id from pr)), 0, 'R5.3 QR purged on success');
select is((select count(*)::int from public.audit_log where action = 'pairing.paired'), 1, 'pairing audited');
select public.create_pairing_request(tests.id('acc_a'), tests.id('owner_a'), 'qr', null, null);
select public.worker_pairing_qr_upsert((select id from public.pairing_requests where state = 'pending' limit 1), 'worker-3', 'QR-2');
update public.pairing_qr set created_at = now() - interval '2 minutes', expires_at = now() - interval '61 seconds';
update public.pairing_requests set expires_at = now() - interval '1 second' where state = 'active';
select ok(public.pairing_purge_expired() >= 1, 'R5.3 expiry purge runs');
select is((select count(*)::int from public.pairing_qr), 0, 'R5.3 expired QR rows purged');
select is((select count(*)::int from public.pairing_requests where state in ('pending', 'active')), 0, 'expired requests closed');

-- Automations helpers.
select is(public.worker_take_cooldown(tests.id('acc_a'), 'STATUS1', '1234@lid'), false, 'R2.2 second reply to same status skipped');
select is(public.worker_take_cooldown(tests.id('acc_a'), 'STATUS1', '9999@lid'), true, 'R2.2 other contact may get a reply');
select is((select array_agg(lid) from public.contacts where account_id = tests.id('acc_a')), array['1234@lid'],
  'contact fixture');
select is(public.worker_upsert_contact(tests.id('acc_a'), '15550000009@s.whatsapp.net', null, 'New name'),
  (select id from public.contacts where lid = '1234@lid'), 'L1.2 PN and LID resolve to the same contact');

-- Relay batch from the worker is idempotent on batch_id.
create temp table rb on commit drop as select batch_id from public.relay_batches limit 1;
select is(public.worker_create_relay_batch(tests.id('target_a'),
  (select message_ids from public.relay_batches limit 1), null, false, (select batch_id from rb)),
  (select batch_id from rb), 'L4.7 same batch_id returns the same batch');
select is((select count(*)::int from public.relay_batches), 1, 'L4.7 no duplicate batch');

select * from finish();
rollback;
