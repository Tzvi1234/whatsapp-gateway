-- L2.2, L4.10 and other enum/shape constraints.
begin;
set local client_min_messages = warning;
select plan(17);
select tests.create_fixture();

-- L2.2: relay keys must be bound to a non-empty conversation list (direct INSERT and RPC).
select throws_ok(
  format($s$insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, conversation_ids)
            values (%L, 'lia', 'gw_l22a', repeat('b', 64), array['relay', 'messages:send'], null)$s$, tests.id('org_a')),
  '23514', null, 'L2.2 relay key with NULL conversation_ids rejected by CHECK (direct INSERT)');
select throws_ok(
  format($s$insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, conversation_ids)
            values (%L, 'lia', 'gw_l22b', repeat('b', 64), array['relay'], '{}')$s$, tests.id('org_a')),
  '23514', null, 'L2.2 relay key with EMPTY conversation_ids rejected by CHECK (direct INSERT)');
select throws_ok(
  format($s$select public.create_api_client(%L, 'lia', 'gw_l22c', repeat('b', 64), array['relay'], '{}', '{}')$s$,
         tests.id('org_a')),
  '23514', null, 'L2.2 relay key with empty conversation_ids rejected (create_api_client RPC)');
select throws_ok(
  format($s$update public.api_clients set scopes = array['relay'] where id = %L$s$, tests.id('api_a')),
  '23514', null, 'L2.2 adding relay scope to an unbound key is rejected');
select lives_ok(
  format($s$insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, conversation_ids)
            values (%L, 'lia', 'gw_l22d', repeat('b', 64), array['relay'], array[gen_random_uuid()])$s$, tests.id('org_a')),
  'L2.2 relay key bound to a conversation is accepted');
select lives_ok(
  format($s$insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, conversation_ids)
            values (%L, 'agent', 'gw_l22e', repeat('b', 64), array['messages:send'], null)$s$, tests.id('org_a')),
  'L2.2 non-relay key may keep conversation_ids NULL');
select throws_ok(
  format($s$insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes)
            values (%L, 'x', 'gw_bad', repeat('b', 64), array['admin:all'])$s$, tests.id('org_a')),
  '23514', null, 'S8 unknown scope rejected');
select throws_ok(
  format($s$insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes)
            values (%L, 'x', 'gw_plain', 'not-a-hash', '{}')$s$, tests.id('org_a')),
  '23514', null, 'S8 key_hash must be a sha256 hex digest (never plaintext)');

-- L4.10: relay_batches.status only accepts the 6 canonical values.
select throws_ok(
  $s$update public.relay_batches set status = 'waiting'$s$, '23514', null,
  'L4.10 relay_batches.status rejects a non-enum value (waiting)');
select throws_ok(
  $s$update public.relay_batches set status = 'untested'$s$, '23514', null,
  'L4.10 relay_batches.status rejects untested (channel state, not a status)');
select is(
  (select array_agg(v order by v) from unnest(array['accepted', 'replied', 'rejected_key', 'unreachable', 'no_reply',
     'delivery_failed']) v
   where tests.try_sql('postgres', null, format('update public.relay_batches set status = %L', v)) like 'ok:%'),
  array['accepted', 'delivery_failed', 'no_reply', 'rejected_key', 'replied', 'unreachable'],
  'L4.10 all 6 canonical values are accepted');
select throws_ok(
  format($s$update public.relay_targets set last_test = '{"status": "failed"}' where id = %L$s$, tests.id('target_a')),
  '23514', null, 'L4.10 relay_targets.last_test.status must be canonical');
select throws_ok(
  format($s$update public.relay_targets set no_reply_threshold_min = 15 where id = %L$s$, tests.id('target_a')),
  '23514', null, 'L4.3 no_reply threshold only 5/10/30');
select is((select no_reply_threshold_min from public.relay_targets where id = tests.id('target_a')), 10,
  'L4.3 no_reply threshold defaults to 10 min');
select throws_ok(
  format($s$update public.relay_targets set allowed_senders = array['0559014410'] where id = %L$s$, tests.id('target_a')),
  '23514', null, 'C7 allowlist entries must be E.164');
select throws_ok(
  $s$update public.messages set status = 'delivered_late'$s$, '23514', null, 'MessageStatus enum enforced');
select throws_ok(
  format($s$update public.accounts set provider = 'whatsmeow' where id = %L$s$, tests.id('acc_a')),
  '23514', null, 'ProviderKind enum enforced');

select * from finish();
rollback;
