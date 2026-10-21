-- Server-side RPCs (Vercel, role service_role): API keys, rate limits, Vault, provider
-- credentials, relay target/allowlist/statuses, webhook deliveries, login lockout,
-- dashboard commands. ARCH §4.7, §6, §7.2, §7.5; TEST-PLAN S8, L5.5, L6.1, R5.1, C5.

-- ---------------------------------------------------------------------------
-- Vault wrappers (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.vault_store_secret(p_name text, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_secret is null or p_secret = '' then
    raise exception 'secret required' using errcode = '22023';
  end if;
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    v_id := vault.create_secret(p_secret, p_name);
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
  return v_id;
end
$$;

create or replace function public.vault_read_secret(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.id = p_id
$$;

-- Internal: store/rotate a secret in place (keeps the vault id stable).
create or replace function public.vault_put(p_existing uuid, p_name text, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_existing is not null and exists (select 1 from vault.secrets s where s.id = p_existing) then
    perform vault.update_secret(p_existing, p_secret);
    return p_existing;
  end if;
  return vault.create_secret(p_secret, p_name || ':' || gen_random_uuid()::text);
end
$$;

create or replace function public.last4(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p is null then null else right(p, 4) end
$$;

-- ---------------------------------------------------------------------------
-- Provider credentials (Meta Cloud API). Secrets -> Vault; table keeps ids + last 4 (C5).
-- Null secret params keep the existing secret.
-- ---------------------------------------------------------------------------
create or replace function public.provider_credentials_upsert(
  p_account_id uuid,
  p_phone_number_id text default null,
  p_waba_id text default null,
  p_access_token text default null,
  p_app_secret text default null,
  p_verify_token text default null,
  p_verified_webhook_url text default null,
  p_actor_user_id uuid default null,
  p_ip inet default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  c public.provider_credentials%rowtype;
  v_prefix text;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found or a.provider <> 'meta_cloud' then
    raise exception 'meta_cloud account % not found', p_account_id using errcode = 'P0002';
  end if;
  v_prefix := 'provider_credentials:' || a.id::text;

  insert into public.provider_credentials (org_id, account_id) values (a.org_id, a.id)
  on conflict (account_id) do nothing;
  select * into c from public.provider_credentials where account_id = a.id for update;

  update public.provider_credentials set
    phone_number_id = coalesce(p_phone_number_id, phone_number_id),
    waba_id = coalesce(p_waba_id, waba_id),
    vault_secret_id = case when p_access_token is null then vault_secret_id
                           else public.vault_put(c.vault_secret_id, v_prefix || ':token', p_access_token) end,
    token_last4 = coalesce(public.last4(p_access_token), token_last4),
    app_secret_vault_id = case when p_app_secret is null then app_secret_vault_id
                               else public.vault_put(c.app_secret_vault_id, v_prefix || ':app_secret', p_app_secret) end,
    app_secret_last4 = coalesce(public.last4(p_app_secret), app_secret_last4),
    verify_token_vault_id = case when p_verify_token is null then verify_token_vault_id
                                 else public.vault_put(c.verify_token_vault_id, v_prefix || ':verify_token', p_verify_token) end,
    verify_token_last4 = coalesce(public.last4(p_verify_token), verify_token_last4),
    verified_webhook_url = coalesce(p_verified_webhook_url, verified_webhook_url),
    webhook_verified_at = case when p_verified_webhook_url is not null then now() else webhook_verified_at end,
    last_verified_at = now()
  where id = c.id;

  perform public.audit_append(a.org_id, case when p_actor_user_id is null then 'system' else 'user' end,
    p_actor_user_id::text, 'provider_credentials.upsert', 'account:' || a.id, p_ip,
    jsonb_build_object('phone_number_id', p_phone_number_id, 'waba_id', p_waba_id,
      'token_changed', p_access_token is not null, 'app_secret_changed', p_app_secret is not null,
      'verify_token_changed', p_verify_token is not null));
  return c.id;
end
$$;

-- Plaintext credentials for the Graph call on Vercel. service_role only; never returned to clients.
create or replace function public.provider_credentials_read(p_account_id uuid)
returns table (phone_number_id text, waba_id text, access_token text, app_secret text, verify_token text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.phone_number_id, c.waba_id,
         (select s.decrypted_secret from vault.decrypted_secrets s where s.id = c.vault_secret_id),
         (select s.decrypted_secret from vault.decrypted_secrets s where s.id = c.app_secret_vault_id),
         (select s.decrypted_secret from vault.decrypted_secrets s where s.id = c.verify_token_vault_id)
  from public.provider_credentials c
  where c.account_id = p_account_id
$$;

-- Meta webhook GET verification passed with this URL (C15 banner compares it to PUBLIC_BASE_URL).
create or replace function public.provider_credentials_mark_webhook_verified(p_account_id uuid, p_url text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.provider_credentials set verified_webhook_url = p_url, webhook_verified_at = now()
   where account_id = p_account_id
  returning true
$$;

-- ---------------------------------------------------------------------------
-- API clients (MCP keys). The caller generates the key, shows it once, passes only the hash.
-- ---------------------------------------------------------------------------
create or replace function public.create_api_client(
  p_org_id uuid,
  p_name text,
  p_key_prefix text,
  p_key_hash text,
  p_scopes text[],
  p_account_ids uuid[] default '{}',
  p_conversation_ids uuid[] default null,
  p_rate_limit jsonb default null,
  p_expires_at timestamptz default null,
  p_legacy boolean default false,
  p_actor_user_id uuid default null,
  p_ip inet default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from unnest(coalesce(p_account_ids, '{}')) x(id)
             where not exists (select 1 from public.accounts a where a.id = x.id and a.org_id = p_org_id)) then
    raise exception 'account_ids must belong to org' using errcode = '22023';
  end if;
  insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, account_ids, conversation_ids,
    rate_limit, expires_at, legacy, created_by)
  values (p_org_id, p_name, p_key_prefix, lower(p_key_hash), coalesce(p_scopes, '{}'), coalesce(p_account_ids, '{}'),
    p_conversation_ids, coalesce(p_rate_limit, '{"requests_per_min": 60, "sends_per_min": 20}'::jsonb),
    p_expires_at, coalesce(p_legacy, false), p_actor_user_id)
  returning id into v_id;
  perform public.audit_append(p_org_id, case when p_actor_user_id is null then 'system' else 'user' end,
    p_actor_user_id::text, 'api_client.create', 'api_client:' || v_id, p_ip,
    jsonb_build_object('name', p_name, 'key_prefix', p_key_prefix, 'scopes', p_scopes,
      'account_ids', p_account_ids, 'conversation_ids', p_conversation_ids, 'legacy', p_legacy));
  return v_id;
end
$$;

create or replace function public.revoke_api_client(p_id uuid, p_actor_user_id uuid default null,
  p_ip inet default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  update public.api_clients set revoked_at = now() where id = p_id and revoked_at is null
  returning org_id into v_org;
  if v_org is null then
    return false;
  end if;
  perform public.audit_append(v_org, case when p_actor_user_id is null then 'system' else 'user' end,
    p_actor_user_id::text, 'api_client.revoke', 'api_client:' || p_id, p_ip, '{}'::jsonb);
  return true;
end
$$;

-- Active keys only (revoked / expired -> no row -> unauthorized; fail closed). The caller
-- compares SHA-256(secret) with key_hash using timingSafeEqual, then calls api_client_touch.
create or replace function public.lookup_api_client(p_key_prefix text)
returns table (id uuid, org_id uuid, name text, key_hash text, scopes text[], account_ids uuid[],
  conversation_ids uuid[], rate_limit jsonb, expires_at timestamptz, legacy boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.org_id, c.name, c.key_hash, c.scopes, c.account_ids, c.conversation_ids, c.rate_limit,
         c.expires_at, c.legacy
  from public.api_clients c
  where c.key_prefix = p_key_prefix
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
$$;

create or replace function public.api_client_touch(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.api_clients set last_used_at = now()
   where id = p_id and (last_used_at is null or last_used_at < now() - interval '1 minute')
$$;

-- ---------------------------------------------------------------------------
-- Token bucket rate limiter (ARCH §6). Atomic per key.
-- ---------------------------------------------------------------------------
create or replace function public.rate_limit_take(p_key text, p_capacity int, p_refill_per_sec double precision,
  p_cost int default 1)
returns table (allowed boolean, retry_after_ms int, remaining double precision)
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.rate_limit_buckets%rowtype;
  v_tokens double precision;
begin
  if p_capacity <= 0 or p_refill_per_sec <= 0 or p_cost <= 0 then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;
  insert into public.rate_limit_buckets (key, tokens, capacity, refill_per_sec)
  values (p_key, p_capacity, p_capacity, p_refill_per_sec)
  on conflict (key) do nothing;
  select * into b from public.rate_limit_buckets where key = p_key for update;

  v_tokens := least(p_capacity::double precision,
    b.tokens + greatest(extract(epoch from (clock_timestamp() - b.updated_at)), 0) * p_refill_per_sec);

  if v_tokens >= p_cost then
    v_tokens := v_tokens - p_cost;
    allowed := true;
    retry_after_ms := 0;
  else
    allowed := false;
    retry_after_ms := ceil((p_cost - v_tokens) / p_refill_per_sec * 1000)::int;
  end if;
  update public.rate_limit_buckets
     set tokens = v_tokens, capacity = p_capacity, refill_per_sec = p_refill_per_sec, updated_at = clock_timestamp()
   where key = p_key;
  remaining := v_tokens;
  return next;
end
$$;

-- ---------------------------------------------------------------------------
-- Login lockout (ARCH §7.5, R5.1): 8 failures within 15 min per email+IP -> locked 15 min.
-- ---------------------------------------------------------------------------
create or replace function public.login_check_lockout(p_email text, p_ip inet)
returns table (locked boolean, retry_after_seconds int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_last_success timestamptz;
  v_until timestamptz;
begin
  select max(l.at) into v_last_success from public.login_attempts l
   where l.email = v_email and l.ip is not distinct from p_ip and l.success;

  with fails as (
    select l.at from public.login_attempts l
    where l.email = v_email and l.ip is not distinct from p_ip and not l.success
      and l.at > now() - interval '30 minutes'
      and l.at > coalesce(v_last_success, '-infinity'::timestamptz)
  )
  select max(f.at) + interval '15 minutes' into v_until
  from fails f
  where (select count(*) from fails g where g.at > f.at - interval '15 minutes' and g.at <= f.at) >= 8;

  locked := v_until is not null and v_until > now();
  retry_after_seconds := case when locked then ceil(extract(epoch from (v_until - now())))::int else 0 end;
  return next;
end
$$;

create or replace function public.login_record_attempt(p_email text, p_ip inet, p_success boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.login_attempts (email, ip, success) values (lower(trim(p_email)), p_ip, p_success)
$$;

-- ---------------------------------------------------------------------------
-- Dashboard commands
-- ---------------------------------------------------------------------------
create or replace function public.request_session_command(p_account_id uuid, p_command text,
  p_requested_by uuid default null, p_via text default 'dashboard', p_ip inet default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_id uuid;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;
  insert into public.session_commands (org_id, account_id, command, requested_by, requested_via)
  values (a.org_id, a.id, p_command, p_requested_by, p_via)
  returning id into v_id;
  perform public.audit_append(a.org_id, case when p_requested_by is null then 'system' else 'user' end,
    p_requested_by::text, 'session.' || p_command, 'account:' || a.id, p_ip, jsonb_build_object('via', p_via));
  return v_id;
end
$$;

create or replace function public.create_pairing_request(p_account_id uuid, p_requested_by uuid,
  p_method text default 'qr', p_phone_e164 text default null, p_ip inet default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  v_id uuid;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found or a.provider <> 'baileys' then
    raise exception 'baileys account % not found', p_account_id using errcode = 'P0002';
  end if;
  update public.pairing_requests set state = 'cancelled', completed_at = now()
   where account_id = a.id and state in ('pending', 'active');
  delete from public.pairing_qr where account_id = a.id;
  insert into public.pairing_requests (org_id, account_id, method, phone_e164, requested_by)
  values (a.org_id, a.id, p_method, p_phone_e164, p_requested_by)
  returning id into v_id;
  perform public.audit_append(a.org_id, 'user', p_requested_by::text, 'pairing.request', 'account:' || a.id, p_ip,
    jsonb_build_object('method', p_method, 'request_id', v_id));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Relay target (Lia channel)
-- ---------------------------------------------------------------------------
-- Create or update by (account_id, name). Any change of URL or secret resets
-- last_verified_at to null (channel becomes "untested", L5.5). Audited (secret masked).
create or replace function public.relay_set_target(
  p_account_id uuid,
  p_name text,
  p_url text,
  p_secret text default null,
  p_debounce_ms int default null,
  p_no_reply_threshold_min int default null,
  p_enabled boolean default null,
  p_actor_user_id uuid default null,
  p_ip inet default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.accounts%rowtype;
  t public.relay_targets%rowtype;
  v_old jsonb;
  v_secret_changed boolean := false;
  v_url_changed boolean;
  v_vault uuid;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then
    raise exception 'account % not found', p_account_id using errcode = 'P0002';
  end if;

  select * into t from public.relay_targets where account_id = a.id and name = p_name for update;
  if not found then
    if p_secret is null then
      raise exception 'secret required for a new relay target' using errcode = '22023';
    end if;
    insert into public.relay_targets (org_id, account_id, name, url, debounce_ms, no_reply_threshold_min, enabled)
    values (a.org_id, a.id, p_name, p_url, coalesce(p_debounce_ms, 4000), coalesce(p_no_reply_threshold_min, 10),
            coalesce(p_enabled, true))
    returning * into t;
    v_old := null;
  else
    v_old := jsonb_build_object('url', t.url, 'secret_last4', t.secret_last4, 'debounce_ms', t.debounce_ms,
      'no_reply_threshold_min', t.no_reply_threshold_min, 'enabled', t.enabled,
      'last_verified_at', t.last_verified_at);
  end if;

  if p_secret is not null then
    v_secret_changed := t.secret_vault_id is null
      or p_secret is distinct from public.vault_read_secret(t.secret_vault_id);
    if v_secret_changed then
      v_vault := public.vault_put(t.secret_vault_id, 'relay_target:' || t.id::text || ':secret', p_secret);
    end if;
  end if;
  v_url_changed := v_old is not null and p_url is distinct from t.url;

  update public.relay_targets set
    url = p_url,
    secret_vault_id = coalesce(v_vault, secret_vault_id),
    secret_last4 = case when v_secret_changed then public.last4(p_secret) else secret_last4 end,
    debounce_ms = coalesce(p_debounce_ms, debounce_ms),
    no_reply_threshold_min = coalesce(p_no_reply_threshold_min, no_reply_threshold_min),
    enabled = coalesce(p_enabled, enabled),
    last_verified_at = case when v_url_changed or (v_old is not null and v_secret_changed) then null
                            else last_verified_at end
  where id = t.id
  returning * into t;

  perform public.audit_append(a.org_id, case when p_actor_user_id is null then 'system' else 'user' end,
    p_actor_user_id::text, case when v_old is null then 'relay_target.create' else 'relay_target.update' end,
    'relay_target:' || t.id, p_ip,
    jsonb_build_object('before', v_old, 'after', jsonb_build_object('url', t.url, 'secret_last4', t.secret_last4,
      'debounce_ms', t.debounce_ms, 'no_reply_threshold_min', t.no_reply_threshold_min, 'enabled', t.enabled,
      'last_verified_at', t.last_verified_at)));
  return t.id;
end
$$;

-- Allowlist change (L6.1): requires the UI confirmation flag; audit row with before/after.
create or replace function public.relay_allowlist_update(
  p_relay_target_id uuid,
  p_allowed_senders text[],
  p_actor_user_id uuid,
  p_confirmed boolean,
  p_ip inet default null)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.relay_targets%rowtype;
  v_new text[];
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'allowlist change requires confirmation' using errcode = '22023';
  end if;
  select * into t from public.relay_targets where id = p_relay_target_id for update;
  if not found then
    raise exception 'relay target % not found', p_relay_target_id using errcode = 'P0002';
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_new from unnest(coalesce(p_allowed_senders, '{}')) x;
  update public.relay_targets set allowed_senders = v_new where id = t.id;
  perform public.audit_append(t.org_id, 'user', p_actor_user_id::text, 'relay_allowlist.update',
    'relay_target:' || t.id, p_ip,
    jsonb_build_object('before', to_jsonb(t.allowed_senders), 'after', to_jsonb(v_new)));
  return v_new;
end
$$;

-- Store the latest connection-test result (LiaTestResult). `replied` marks the channel verified.
create or replace function public.relay_record_test(p_relay_target_id uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.relay_targets
     set last_test = p_result,
         last_verified_at = case when p_result ->> 'status' = 'replied' then now() else last_verified_at end
   where id = p_relay_target_id;
  return found;
end
$$;

-- Lia replied to a batch (send_message with reply_to_id = batch). Late replies after
-- no_reply still count. Test batches verify the channel.
create or replace function public.relay_mark_replied(p_batch_id uuid, p_at timestamptz default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.relay_batches%rowtype;
  v_at timestamptz := coalesce(p_at, now());
begin
  update public.relay_batches
     set status = 'replied', first_response_at = coalesce(first_response_at, v_at),
         replied_at = coalesce(replied_at, v_at)
   where batch_id = p_batch_id and status in ('accepted', 'no_reply', 'unreachable')
  returning * into b;
  if not found then
    return false;
  end if;
  if b.is_test then
    update public.relay_targets set last_verified_at = v_at where id = b.relay_target_id;
  end if;
  update public.alerts set resolved_at = now()
   where kind = 'relay_no_reply' and ref_id = p_batch_id::text and resolved_at is null;
  return true;
end
$$;

-- Lia replied but sending the reply to the user failed (e.g. Baileys disconnected).
create or replace function public.relay_mark_delivery_failed(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.relay_batches
     set status = 'delivery_failed', first_response_at = coalesce(first_response_at, now())
   where batch_id = p_batch_id and status in ('accepted', 'replied', 'no_reply');
  return found;
end
$$;

-- "Resend to Lia": same batch_id and message_ids (receiver dedups on batch_id).
create or replace function public.relay_resend_batch(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.relay_batches
     set status = null, attempts = 0, next_attempt_at = now(), lease_owner = null, lease_until = null,
         last_error = null, last_response_code = null
   where batch_id = p_batch_id and status is distinct from 'replied';
  return found;
end
$$;

-- pg_cron every minute: accepted batches with no reply past the target's threshold -> no_reply.
create or replace function public.relay_evaluate_no_reply()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int := 0;
  r record;
begin
  for r in
    update public.relay_batches b
       set status = 'no_reply'
      from public.relay_targets t
     where t.id = b.relay_target_id
       and b.status = 'accepted'
       and b.accepted_at < now() - make_interval(mins => t.no_reply_threshold_min)
    returning b.batch_id, b.org_id, b.account_id, b.is_test, t.name, t.no_reply_threshold_min
  loop
    v_n := v_n + 1;
    if not r.is_test then
      insert into public.alerts (org_id, severity, kind, account_id, ref_id, message)
      values (r.org_id, 'P2', 'relay_no_reply', r.account_id, r.batch_id::text,
              format('%s did not reply within %s min', r.name, r.no_reply_threshold_min));
    end if;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- Delivery claims (deliver-webhooks Edge Function -> Vercel /api/internal/deliver)
-- ---------------------------------------------------------------------------
create or replace function public.claim_deliveries(p_worker_id text, p_n int default 20)
returns table (kind text, id uuid, attempt int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id from public.webhook_deliveries d
    where d.status in ('pending', 'failed') and d.next_attempt_at <= now()
      and (d.lease_until is null or d.lease_until < now())
    order by d.next_attempt_at
    limit greatest(coalesce(p_n, 20), 0)
    for update skip locked
  ), upd as (
    update public.webhook_deliveries d
       set lease_owner = p_worker_id, lease_until = now() + interval '60 seconds'
      from due where d.id = due.id
    returning d.id, d.attempt
  )
  select 'webhook'::text, upd.id, upd.attempt from upd;

  return query
  with due as (
    select b.id from public.relay_batches b
    where b.status is null and b.next_attempt_at <= now()
      and (b.lease_until is null or b.lease_until < now())
    order by b.next_attempt_at
    limit greatest(coalesce(p_n, 20), 0)
    for update skip locked
  ), upd as (
    update public.relay_batches b
       set lease_owner = p_worker_id, lease_until = now() + interval '60 seconds'
      from due where b.id = due.id
    returning b.batch_id, b.attempts
  )
  select 'relay'::text, upd.batch_id, upd.attempts from upd;
end
$$;

-- Generic webhook attempt result. 2xx -> delivered; else retry 10s,30s,2m,10m,30m,2h (+-20% jitter),
-- then dead + alert.
create or replace function public.webhook_delivery_result(p_id uuid, p_response_code int,
  p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.webhook_deliveries%rowtype;
begin
  select * into d from public.webhook_deliveries where id = p_id for update;
  if not found then
    raise exception 'delivery % not found', p_id using errcode = 'P0002';
  end if;
  if d.status in ('delivered', 'dead') then
    return d.status;
  end if;
  if p_response_code between 200 and 299 then
    update public.webhook_deliveries
       set status = 'delivered', attempt = d.attempt + 1, response_code = p_response_code, delivered_at = now(),
           lease_owner = null, lease_until = null, last_error = null
     where id = p_id;
    return 'delivered';
  end if;
  if d.attempt + 1 >= d.max_attempts then
    update public.webhook_deliveries
       set status = 'dead', attempt = d.attempt + 1, response_code = p_response_code, last_error = p_error,
           lease_owner = null, lease_until = null
     where id = p_id;
    insert into public.alerts (org_id, severity, kind, ref_id, message)
    values (d.org_id, 'P2', 'webhook_failing', d.id::text,
            format('Webhook delivery %s (%s) dead after %s attempts', d.id, d.event, d.attempt + 1));
    return 'dead';
  end if;
  update public.webhook_deliveries
     set status = 'failed', attempt = d.attempt + 1, response_code = p_response_code, last_error = p_error,
         lease_owner = null, lease_until = null,
         next_attempt_at = now() + public.webhook_backoff(d.attempt + 1) * (0.8 + random() * 0.4)
   where id = p_id;
  return 'failed';
end
$$;

-- Relay POST result -> canonical status. 2xx accepted; 401/403 rejected_key;
-- 0 (network/timeout), 408, 429, 5xx retried, then unreachable; other 4xx unreachable at once.
create or replace function public.relay_batch_delivery_result(p_batch_id uuid, p_http_status int,
  p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.relay_batches%rowtype;
  v_status text;
begin
  select * into b from public.relay_batches where batch_id = p_batch_id for update;
  if not found then
    raise exception 'batch % not found', p_batch_id using errcode = 'P0002';
  end if;
  if b.status is not null then
    return b.status;   -- already resolved (idempotent)
  end if;

  if p_http_status between 200 and 299 then
    v_status := 'accepted';
  elsif p_http_status in (401, 403) then
    v_status := 'rejected_key';
  elsif (coalesce(p_http_status, 0) = 0 or p_http_status in (408, 429) or p_http_status >= 500)
        and b.attempts + 1 < b.max_attempts then
    v_status := null;  -- retry
  else
    v_status := 'unreachable';
  end if;

  update public.relay_batches
     set status = v_status, attempts = b.attempts + 1, last_response_code = p_http_status, last_error = p_error,
         lease_owner = null, lease_until = null,
         accepted_at = case when v_status = 'accepted' then now() else accepted_at end,
         next_attempt_at = case when v_status is null
                                then now() + public.webhook_backoff(b.attempts + 1) * (0.8 + random() * 0.4)
                                else next_attempt_at end
   where id = b.id;

  if v_status in ('rejected_key', 'unreachable') and not b.is_test then
    insert into public.alerts (org_id, severity, kind, account_id, ref_id, message)
    values (b.org_id, 'P2', case when v_status = 'rejected_key' then 'relay_rejected_key' else 'relay_unreachable' end,
            b.account_id, p_batch_id::text, format('Relay batch %s: %s (HTTP %s)', p_batch_id, v_status,
            coalesce(p_http_status, 0)));
  end if;
  return coalesce(v_status, 'retry');
end
$$;
