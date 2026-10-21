-- Status-reply automations (ported from WhatsApp-Automation SQLite + account_id),
-- reminders, agent relay (Lia channel) and generic outbound webhooks.

-- ---------------------------------------------------------------------------
-- Automations (ARCH §9.3 behaviour 1-2)
-- ---------------------------------------------------------------------------
create table public.statuses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  provider_status_id text not null,
  kind text,
  caption text,
  media_path text,
  posted_at timestamptz not null default now(),
  expires_at timestamptz,
  legacy_id text,
  created_at timestamptz not null default now(),
  unique (account_id, provider_status_id)
);

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  bind_mode text not null default 'status' check (bind_mode in ('status', 'next_status')),
  status_id uuid references public.statuses (id) on delete set null,
  keywords text[] not null default '{}',
  match_mode text not null default 'contains' check (match_mode in ('exact', 'contains')),
  case_sensitive boolean not null default false,
  ignore_emoji boolean not null default true,
  reply_text text,
  reply_media_path text,
  options text[] not null default '{}' check (cardinality(options) <= 10),
  try_native_buttons boolean not null default false,
  daily_cap int check (daily_cap is null or daily_cap >= 0),
  max_age_sec int not null default 300,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automations_account_idx on public.automations (account_id) where enabled;
create trigger automations_updated_at before update on public.automations
  for each row execute function public.set_updated_at();

-- One reply per contact per status (R2.2). contact_key is LID-or-PN normalised by the worker.
create table public.automation_cooldowns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  automation_id uuid references public.automations (id) on delete cascade,
  status_id uuid references public.statuses (id) on delete cascade,
  provider_status_id text not null,
  contact_key text not null,
  replied_at timestamptz not null default now(),
  unique (account_id, provider_status_id, contact_key)
);

create table public.reply_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  automation_id uuid references public.automations (id) on delete set null,
  status_id uuid references public.statuses (id) on delete set null,
  inbound_message_id uuid references public.messages (id) on delete set null,
  outbound_message_id uuid references public.messages (id) on delete set null,
  contact_key text,
  outcome text not null check (outcome in ('queued', 'sent', 'failed', 'skipped_disabled', 'skipped_not_direct',
    'skipped_cooldown', 'skipped_stale', 'skipped_cap', 'skipped_no_match')),
  detail text,
  created_at timestamptz not null default now()
);
create index reply_jobs_account_created_idx on public.reply_jobs (account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Reminders (Cloud API, ported)
-- ---------------------------------------------------------------------------
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  legacy_id text,
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  body text,
  template_name text,
  template_language text,
  template_params jsonb not null default '[]'::jsonb,
  due_at timestamptz not null,
  state text not null default 'scheduled' check (state in
    ('scheduled', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unconfigured', 'cancelled')),
  attempts int not null default 0,
  message_id uuid references public.messages (id) on delete set null,
  api_client_id uuid references public.api_clients (id) on delete set null,
  created_by uuid,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz
);
create index reminders_state_due_idx on public.reminders (state, due_at);
create trigger reminders_updated_at before update on public.reminders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Agent relay (ARCH §4.7, contracts/lia-connection-test.md)
-- ---------------------------------------------------------------------------
create table public.relay_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null,
  url text not null check (url ~ '^https://'),   -- full SSRF guard runs in the app on save + send
  secret_vault_id uuid,
  secret_last4 text check (secret_last4 is null or length(secret_last4) <= 4),
  enabled boolean not null default true,
  debounce_ms int not null default 4000 check (debounce_ms between 3000 and 5000),
  no_reply_threshold_min int not null default 10 check (no_reply_threshold_min in (5, 10, 30)),
  allowed_senders text[] not null default '{}' check (public.is_e164_array(allowed_senders)),
  -- Channel state "untested" = last_verified_at is null; set only when a test reaches `replied`.
  last_verified_at timestamptz,
  last_test jsonb check (last_test is null or (last_test ->> 'status') in
    ('accepted', 'replied', 'rejected_key', 'unreachable', 'no_reply', 'delivery_failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, name)
);
create trigger relay_targets_updated_at before update on public.relay_targets
  for each row execute function public.set_updated_at();

alter table public.conversations
  add constraint conversations_relay_target_fk foreign key (relay_target_id)
  references public.relay_targets (id) on delete set null;

create table public.relay_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  batch_id uuid not null unique default gen_random_uuid(),  -- stable across retries/resend; Idempotency-Key
  relay_target_id uuid not null references public.relay_targets (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_ids uuid[] not null check (cardinality(message_ids) > 0),
  is_test boolean not null default false,
  -- Canonical LiaTestStatus enum, exactly these 6 values (L4.10). null = not yet delivered.
  status text check (status in ('accepted', 'replied', 'rejected_key', 'unreachable', 'no_reply', 'delivery_failed')),
  attempts int not null default 0,
  max_attempts int not null default 6,
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  last_response_code int,
  last_error text,
  first_message_at timestamptz,  -- Tzvi's first message in the batch (metric start)
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  first_response_at timestamptz,
  replied_at timestamptz,
  updated_at timestamptz not null default now()
);
create index relay_batches_due_idx on public.relay_batches (next_attempt_at) where status is null;
create index relay_batches_accepted_idx on public.relay_batches (accepted_at) where status = 'accepted';
create index relay_batches_target_created_idx on public.relay_batches (relay_target_id, created_at desc);
create trigger relay_batches_updated_at before update on public.relay_batches
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Generic outbound webhooks
-- ---------------------------------------------------------------------------
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete cascade,  -- null = all accounts of the org
  url text not null check (url ~ '^https://'),
  events text[] not null check (cardinality(events) > 0
    and events <@ array['message.received', 'message.status', 'session.changed']::text[]),
  secret_vault_id uuid,
  previous_secret_vault_id uuid,   -- dual-secret overlap during rotation
  secret_last4 text check (secret_last4 is null or length(secret_last4) <= 4),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger webhook_endpoints_updated_at before update on public.webhook_endpoints
  for each row execute function public.set_updated_at();

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  event text not null,
  payload jsonb,                  -- purged (set null) by retention after 7 days
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'dead')),
  attempt int not null default 0,
  max_attempts int not null default 6,  -- 10s, 30s, 2m, 10m, 30m, 2h
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  response_code int,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index webhook_deliveries_pending_idx on public.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'failed');
