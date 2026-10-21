-- Test helpers (schema `tests`). This file runs first (pg_prove / `supabase test db` run
-- files in name order) and COMMITS its helpers so later files can use them.
-- Fixture data itself is created inside each test file's transaction and rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(1);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role, gateway_worker;

-- Fixed ids used by every test file.
create or replace function tests.id(p_name text)
returns uuid
language sql
immutable
as $$
  select (case p_name
    when 'org_a' then 'aaaaaaaa-0000-4000-8000-000000000001'
    when 'org_b' then 'bbbbbbbb-0000-4000-8000-000000000001'
    when 'owner_a' then 'aaaaaaaa-0000-4000-8000-0000000000a1'
    when 'viewer_a' then 'aaaaaaaa-0000-4000-8000-0000000000a2'
    when 'owner_b' then 'bbbbbbbb-0000-4000-8000-0000000000b1'
    when 'acc_a' then 'aaaaaaaa-0000-4000-8000-0000000000c1'   -- baileys
    when 'acc_a_cloud' then 'aaaaaaaa-0000-4000-8000-0000000000c2'
    when 'acc_b' then 'bbbbbbbb-0000-4000-8000-0000000000c1'
    when 'api_a' then 'aaaaaaaa-0000-4000-8000-0000000000d1'
    when 'target_a' then 'aaaaaaaa-0000-4000-8000-0000000000e1'
    when 'endpoint_a' then 'aaaaaaaa-0000-4000-8000-0000000000f1'
  end)::uuid
$$;

-- JWT claims for a dashboard user.
create or replace function tests.claims(p_user text, p_aal text default 'aal2')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('sub', tests.id(p_user), 'role', 'authenticated', 'aal', p_aal)
$$;

-- Run p_sql as p_role with p_claims; ALWAYS rolls the statement's effects back.
-- Returns 'ok:<row_count>' or 'err:<sqlstate>'.
create or replace function tests.try_sql(p_role text, p_claims jsonb, p_sql text)
returns text
language plpgsql
as $$
declare
  v_n bigint;
  v_res text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_n = row_count;
    v_res := 'ok:' || v_n;
    raise exception using errcode = 'P0001', message = '__tests_rollback__';
  exception when others then
    if sqlerrm <> '__tests_rollback__' then
      v_res := 'err:' || sqlstate;
    end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_res;
end
$$;

-- Like try_sql but keeps the effects (for multi-step scenarios run as a role).
create or replace function tests.run_as(p_role text, p_claims jsonb, p_sql text)
returns text
language plpgsql
as $$
declare
  v_res text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_res;
  exception when others then
    v_res := 'err:' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_res;
end
$$;

-- Rows in EVERY public table for org A (and a few for org B), so "sees nothing" is meaningful.
create or replace function tests.create_fixture()
returns void
language plpgsql
as $$
declare
  oa uuid := tests.id('org_a');
  ob uuid := tests.id('org_b');
  acc uuid := tests.id('acc_a');
  accc uuid := tests.id('acc_a_cloud');
  accb uuid := tests.id('acc_b');
  v_conv uuid;
  v_in uuid;
  v_out uuid;
  v_status uuid;
  v_auto uuid;
  v_req uuid;
  v_batch uuid;
  v_int uuid;
begin
  insert into public.orgs (id, name) values (oa, 'Org A'), (ob, 'Org B');
  insert into public.org_members (org_id, user_id, role) values
    (oa, tests.id('owner_a'), 'owner'), (oa, tests.id('viewer_a'), 'viewer'), (ob, tests.id('owner_b'), 'owner');
  insert into public.accounts (id, org_id, provider, label, alias, phone_e164, is_test) values
    (acc, oa, 'baileys', 'Test Baileys', 'default', '+15550000001', true),
    (accc, oa, 'meta_cloud', 'Test Cloud', 'meta-default', '+15550000002', true),
    (accb, ob, 'baileys', 'Other org', 'default', '+15550000003', true);

  perform public.provider_credentials_upsert(accc, '1000001', '2000001', 'EAAtesttoken1234', 'appsecret5678',
    'verify9012', null, tests.id('owner_a'), null);
  insert into public.baileys_auth_state (org_id, account_id, key_type, key_id, ciphertext, nonce)
  values (oa, acc, 'creds', 'creds', '\x00'::bytea, '\x00'::bytea);
  insert into public.sessions (org_id, account_id, connection) values (oa, acc, 'open'), (ob, accb, 'open');
  insert into public.session_events (org_id, account_id, event, at) values
    (oa, acc, 'open', now() - interval '2 hours'), (oa, acc, 'close', now() - interval '1 hour'),
    (oa, acc, 'open', now() - interval '59 minutes');

  v_req := public.create_pairing_request(acc, tests.id('owner_a'), 'qr', null, null);
  insert into public.pairing_qr (org_id, request_id, account_id, qr) values (oa, v_req, acc, 'QR-PAYLOAD');

  insert into public.contacts (org_id, account_id, pn_jid, lid, display_name)
  values (oa, acc, '15550000009@s.whatsapp.net', '1234@lid', 'Fictitious');

  -- API client (bound to conversation later) + messages.
  perform public.create_api_client(oa, 'agent', 'gw_test1', repeat('a', 64), array['messages:send'], array[acc],
    null, null, null, false, tests.id('owner_a'), null);
  update public.api_clients set id = tests.id('api_a') where key_prefix = 'gw_test1';

  select message_id, conversation_id into v_in, v_conv
  from public.ingest_inbound(acc, 'WAIN0001', '15550000009@s.whatsapp.net', 'text', 'hello',
    '15550000009@s.whatsapp.net', false, 'Fictitious', now(), false, null, 'media/in/1.ogg', 'audio/ogg', 5, 'pending',
    '{"redacted": true}'::jsonb);
  select message_id into v_out from public.enqueue_message(acc, '15550000009@s.whatsapp.net', 'text', 'hi there',
    p_api_client_id => tests.id('api_a'), p_idempotency_key => 'k-1', p_use_case => 'agent_relay');
  perform public.ingest_inbound(accb, 'WAIN-B', '15550000008@s.whatsapp.net', 'text', 'other org');

  insert into public.session_commands (org_id, account_id, command) values (oa, acc, 'reconnect');

  v_status := public.worker_upsert_status(acc, 'STATUS1', 'text', 'my status');
  insert into public.automations (id, org_id, account_id, name, status_id, keywords, reply_text)
  values (gen_random_uuid(), oa, acc, 'auto', v_status, array['hi'], 'hello {name}') returning id into v_auto;
  perform public.worker_take_cooldown(acc, 'STATUS1', '1234@lid', v_auto, v_status);
  perform public.worker_record_reply_job(acc, 'skipped_cooldown', v_auto, v_status, v_in, null, '1234@lid', null);

  insert into public.reminders (org_id, account_id, to_e164, body, due_at)
  values (oa, accc, '+15550000009', 'reminder', now() + interval '1 day');

  perform public.relay_set_target(acc, 'Lia', 'https://hooks.example.test/lia', 'sekret-key-abcd', null, null, null,
    tests.id('owner_a'), null);
  update public.relay_targets set id = tests.id('target_a') where account_id = acc and name = 'Lia';
  v_batch := public.worker_create_relay_batch(tests.id('target_a'), array[v_in], v_conv, false, null);

  insert into public.webhook_endpoints (id, org_id, url, events)
  values (tests.id('endpoint_a'), oa, 'https://hooks.example.test/generic', array['message.received']);
  perform public.ingest_inbound(acc, 'WAIN0002', '15550000009@s.whatsapp.net', 'text', 'second');

  insert into public.alerts (org_id, severity, kind, message) values (oa, 'P3', 'other', 'fixture');
  perform public.record_heartbeat(oa, 'worker-a', '0.0.1', '7.0.0-rc14',
    jsonb_build_array(jsonb_build_object('account_id', acc)));
  perform public.worker_log(oa, 'worker-a', '[{"level": "info", "msg": "fixture"}]'::jsonb);
  perform public.login_record_attempt('someone@example.test', '192.0.2.1', false);
  perform public.rate_limit_take('fixture', 10, 1);
  insert into public.downtime_intervals (org_id, worker_id, started_at, detected_at, ended_at,
    down_email_sent_at, recovered_email_sent_at)
  values (oa, 'worker-a', now() - interval '1 day', now() - interval '1 day', now() - interval '23 hours', now(), now())
  returning id into v_int;
  insert into public.media_purge_queue (org_id, path) values (oa, 'media/old/x.jpg');
  perform public.audit_append(oa, 'system', null, 'fixture', null, null, '{}'::jsonb);
  perform public.audit_append(ob, 'system', null, 'fixture', null, null, '{}'::jsonb);
end
$$;

select ok(true, 'test helpers installed');
select * from finish();
commit;
