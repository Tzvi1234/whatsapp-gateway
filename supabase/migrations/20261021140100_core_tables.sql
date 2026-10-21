-- Core tables: tenancy, accounts, sessions, pairing, contacts, conversations,
-- API clients, messages, queue, commands, inbound events (ARCHITECTURE.md §5).

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid generated always as (id) stored,  -- uniform `org_id` column for RLS/tests
  name text not null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null,  -- auth.users.id
  role text not null default 'viewer' check (role in ('owner', 'admin', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id);

-- ---------------------------------------------------------------------------
-- Accounts & credentials
-- ---------------------------------------------------------------------------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (provider in ('baileys', 'meta_cloud')),
  label text not null,
  alias text,  -- legacy MCP slot ids: 'default' / 'meta-default'
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  status text not null default 'unconfigured' check (status in
    ('connecting', 'open', 'closed', 'needs_relink', 'conflict', 'unconfigured', 'paused')),
  capabilities jsonb not null default '{}'::jsonb,
  use_case_policy jsonb not null default
    '{"allowed_use_cases": [], "may_initiate": false}'::jsonb,
  pacing jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, phone_e164, provider),
  unique (org_id, alias)
);
create trigger accounts_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

-- Meta Cloud API credentials. No plaintext: only Vault ids + last 4 chars (C5).
create table public.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null unique references public.accounts (id) on delete cascade,
  phone_number_id text,
  waba_id text,
  vault_secret_id uuid,          -- access token
  app_secret_vault_id uuid,
  verify_token_vault_id uuid,
  token_last4 text check (token_last4 is null or length(token_last4) <= 4),
  app_secret_last4 text check (app_secret_last4 is null or length(app_secret_last4) <= 4),
  verify_token_last4 text check (verify_token_last4 is null or length(verify_token_last4) <= 4),
  verified_webhook_url text,     -- C15 "address changed, update in Meta" banner
  webhook_verified_at timestamptz,
  last_verified_at timestamptz,  -- last successful Graph credential check
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger provider_credentials_updated_at before update on public.provider_credentials
  for each row execute function public.set_updated_at();

-- Encrypted Baileys auth state (ADR-4). Ciphertext only; key lives on htz-home-01.
create table public.baileys_auth_state (
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  key_type text not null,
  key_id text not null,
  ciphertext bytea not null,
  nonce bytea not null,
  key_version int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (account_id, key_type, key_id)
);

-- ---------------------------------------------------------------------------
-- Sessions & pairing
-- ---------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null unique references public.accounts (id) on delete cascade,
  connection text not null default 'closed' check (connection in
    ('connecting', 'open', 'closed', 'needs_relink', 'conflict', 'unconfigured', 'paused')),
  connected_at timestamptz,
  last_heartbeat_at timestamptz,
  worker_id text,                -- current single-writer lock holder (ADR-4, S5)
  lock_until timestamptz,        -- lease of that lock
  last_error_code text,
  updated_at timestamptz not null default now()
);
create trigger sessions_updated_at before update on public.sessions
  for each row execute function public.set_updated_at();

create table public.session_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  event text not null check (event in
    ('connecting', 'open', 'close', 'qr', 'paired', 'relinked', 'conflict', 'needs_relink', 'logged_out', 'restored')),
  code text,
  worker_id text,
  at timestamptz not null default now()
);
create index session_events_account_at_idx on public.session_events (account_id, at desc);

create table public.pairing_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  method text not null default 'qr' check (method in ('qr', 'pairing_code')),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  requested_by uuid,
  state text not null default 'pending' check (state in ('pending', 'active', 'paired', 'expired', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 minutes',
  completed_at timestamptz
);
create index pairing_requests_expires_idx on public.pairing_requests (expires_at);

-- One live QR / pairing code per request; owner + AAL2 select only (R5.3).
create table public.pairing_qr (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  request_id uuid not null unique references public.pairing_requests (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  qr text,
  pairing_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 seconds',
  check (expires_at <= created_at + interval '60 seconds'),
  check (qr is not null or pairing_code is not null)
);
create index pairing_qr_expires_idx on public.pairing_qr (expires_at);

-- ---------------------------------------------------------------------------
-- Contacts & conversations
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  pn_jid text,
  lid text,
  display_name text,
  is_allowlisted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pn_jid is not null or lid is not null)
);
create unique index contacts_account_identity_uidx on public.contacts (account_id, (coalesce(lid, pn_jid)));
create index contacts_account_pn_idx on public.contacts (account_id, pn_jid);
create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  chat_jid text not null,
  type text not null default 'direct' check (type in ('direct', 'group', 'status')),
  title text,
  last_inbound_at timestamptz,    -- Cloud API 24h window
  last_message_at timestamptz,
  relay_target_id uuid,           -- FK added after relay_targets exists
  created_at timestamptz not null default now(),
  unique (account_id, chat_jid)
);
create index conversations_account_last_msg_idx on public.conversations (account_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- API clients (MCP keys). Plaintext shown once by the server; only SHA-256 stored.
-- ---------------------------------------------------------------------------
create table public.api_clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  key_prefix text not null unique,
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{}' check (scopes <@ array[
    'automations:read', 'automations:write', 'messages:send', 'reminders:send', 'threads:read',
    'sessions:read', 'sessions:write', 'media:send', 'templates:send', 'groups:read', 'groups:send',
    'accounts:read', 'relay']::text[]),
  account_ids uuid[] not null default '{}',
  conversation_ids uuid[],        -- null = unrestricted (never for relay keys)
  rate_limit jsonb not null default '{"requests_per_min": 60, "sends_per_min": 20}'::jsonb,
  legacy boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  -- L2.2: a key with scope `relay` must be bound to a non-empty conversation list.
  constraint api_clients_relay_requires_conversations check (
    not ('relay' = any (scopes))
    or (conversation_ids is not null and cardinality(conversation_ids) > 0)
  )
);

-- ---------------------------------------------------------------------------
-- Messages & queue
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  kind text not null check (kind in (
    'text', 'media', 'template', 'reaction', 'interactive',                       -- outbound kinds
    'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location',        -- inbound types
    'contact', 'poll', 'view_once', 'interactive_reply', 'unknown')),
  body text,
  media_path text,
  media_mime text,
  media_seconds numeric,
  transcript text,
  transcript_ready_at timestamptz,
  template jsonb,
  status text not null default 'queued' check (status in
    ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  delivery_mode text check (delivery_mode in ('native', 'fallback', 'text')),
  provider_message_id text,
  quoted_provider_id text,
  idempotency_key text,
  api_client_id uuid references public.api_clients (id) on delete set null,
  created_by uuid,               -- dashboard user (auth.users.id)
  use_case text check (use_case in
    ('reminders', 'notifications', 'customer_service', 'bookings', 'agent_relay', 'status_automation')),
  error_code text,
  error_detail text,
  sender_jid text,
  from_me boolean not null default false,
  push_name text,
  is_forwarded boolean not null default false,
  relay_state text check (relay_state in ('pending', 'batched', 'skipped')),
  received_at timestamptz,       -- provider timestamp of inbound messages
  requested_at timestamptz,      -- MCP/API/webhook request time (send latency metric)
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  constraint messages_provider_id_uniq unique (account_id, provider_message_id),
  constraint messages_idempotency_uniq unique (api_client_id, idempotency_key)
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at desc);
create index messages_status_open_idx on public.messages (status) where status in ('queued', 'failed');
create index messages_relay_pending_idx on public.messages (account_id) where relay_state = 'pending';
create index messages_created_idx on public.messages (created_at);

create table public.outbound_queue (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,  -- FIFO order (created_at ties within a tx)
  org_id uuid not null references public.orgs (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  executor text not null check (executor in ('worker', 'edge')),
  state text not null default 'ready' check (state in ('ready', 'leased', 'done', 'dead')),
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 6,   -- 1 initial + 5 retries (5s, 30s, 2m, 10m, 15m)
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbound_queue_ready_idx on public.outbound_queue (executor, run_at) where state = 'ready';
create index outbound_queue_leased_idx on public.outbound_queue (lease_until) where state = 'leased';
create index outbound_queue_conv_fifo_idx on public.outbound_queue (conversation_id, seq)
  where state in ('ready', 'leased');
create index outbound_queue_message_idx on public.outbound_queue (message_id);
create trigger outbound_queue_updated_at before update on public.outbound_queue
  for each row execute function public.set_updated_at();

create table public.session_commands (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  command text not null check (command in ('reconnect', 'logout', 'pair')),
  requested_by uuid,
  requested_via text not null default 'dashboard' check (requested_via in ('dashboard', 'mcp', 'system')),
  state text not null default 'pending' check (state in ('pending', 'done', 'failed')),
  result text,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index session_commands_pending_idx on public.session_commands (account_id, created_at) where state = 'pending';

create table public.inbound_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete cascade,
  source text not null check (source in ('meta', 'baileys')),
  dedupe_key text not null unique,
  raw jsonb,                     -- redacted; purged after 7 days (S11)
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
create index inbound_events_received_idx on public.inbound_events (received_at);
