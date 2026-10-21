-- Operational tables: alerts, heartbeats, logs, login lockout, rate limiting,
-- server-down tracking, media purge queue.

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  severity text not null check (severity in ('P1', 'P2', 'P3')),
  kind text not null check (kind in ('worker_down', 'needs_relink', 'conflict', 'failed_rate', 'dead_letter',
    'relay_no_reply', 'relay_unreachable', 'relay_rejected_key', 'webhook_failing', 'other')),
  account_id uuid references public.accounts (id) on delete cascade,
  ref_id text,                   -- job id / batch id / worker id the alert refers to
  message text,
  opened_at timestamptz not null default now(),
  ack_by uuid,
  ack_at timestamptz,
  resolved_at timestamptz
);
create index alerts_open_idx on public.alerts (org_id, opened_at desc) where resolved_at is null;

create table public.worker_heartbeats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  worker_id text not null,
  version text,
  baileys_version text,
  sockets jsonb not null default '[]'::jsonb,
  at timestamptz not null default now()
);
create index worker_heartbeats_worker_at_idx on public.worker_heartbeats (worker_id, at desc);
create index worker_heartbeats_at_idx on public.worker_heartbeats (at);

create table public.worker_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  worker_id text not null,
  level text not null check (level in ('trace', 'debug', 'info', 'warn', 'error', 'fatal')),
  msg text not null,
  correlation_id text,           -- message_id / batch_id
  data jsonb,                    -- already redacted by the worker's pino redaction
  at timestamptz not null default now()
);
create index worker_logs_at_idx on public.worker_logs (at);
create index worker_logs_corr_idx on public.worker_logs (correlation_id) where correlation_id is not null;

-- Login lockout (ARCH §7.5, R5.1). Pre-auth, so org_id is unknown and nullable.
create table public.login_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs (id) on delete cascade,
  email text not null,           -- lower-cased
  ip inet,
  success boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_email_ip_at_idx on public.login_attempts (email, ip, at desc);

-- Postgres token buckets (ARCH §6). Keys are opaque ("apikey:<id>:req" etc.); org_id optional.
create table public.rate_limit_buckets (
  key text primary key,
  org_id uuid references public.orgs (id) on delete cascade,
  tokens double precision not null,
  capacity double precision not null,
  refill_per_sec double precision not null,
  updated_at timestamptz not null default now()
);

-- Server-down detection state machine (ARCH §8.3, RL5). One row per worker.
create table public.heartbeat_state (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  worker_id text not null,
  status text not null default 'up' check (status in ('up', 'down')),
  last_seen_at timestamptz not null,
  down_since timestamptz,        -- last heartbeat before the outage
  current_interval_id uuid,
  updated_at timestamptz not null default now(),
  unique (org_id, worker_id)
);

-- Each outage is one row; it doubles as the e-mail outbox: a "down" mail is owed while
-- down_email_sent_at is null, a "recovered" mail once ended_at is set and
-- recovered_email_sent_at is null. Exactly one of each per outage (RL5).
create table public.downtime_intervals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  worker_id text not null,
  started_at timestamptz not null,   -- last heartbeat seen
  detected_at timestamptz not null,  -- when the stale check fired
  ended_at timestamptz,              -- first heartbeat after recovery
  duration interval generated always as (ended_at - started_at) stored,
  down_email_sent_at timestamptz,
  recovered_email_sent_at timestamptz,
  notify_lease_until timestamptz,    -- claim lease so concurrent invocations never double-send
  notify_attempts int not null default 0
);
create index downtime_intervals_worker_idx on public.downtime_intervals (worker_id, started_at desc);
create index downtime_intervals_outbox_idx on public.downtime_intervals (detected_at)
  where down_email_sent_at is null or recovered_email_sent_at is null;

-- Storage objects whose DB references were purged by retention; deleted through the
-- Storage API (direct DELETE on storage.objects would orphan the files).
create table public.media_purge_queue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  bucket text not null default 'media',
  path text not null,
  reason text not null default 'retention',
  created_at timestamptz not null default now(),
  purged_at timestamptz,
  unique (bucket, path)
);
