-- Minimal emulation of the Supabase platform objects the migrations depend on.
-- NOT part of the repo. Applied to a fresh scratch DB before supabase/migrations/*.sql.
\set ON_ERROR_STOP on

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_admin nologin superuser;
grant anon, authenticated, service_role to authenticator;

create schema extensions;
create extension pgcrypto with schema extensions;
create extension pgtap with schema extensions;
grant usage on schema extensions to public;
alter database gw_test set search_path = "$user", public, extensions;
set search_path = "$user", public, extensions;

-- auth
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Supabase's default exposure of public (so our explicit revokes are exercised)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- vault
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, created_at, updated_at
  from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null,
  new_description text default '', new_key_id uuid default null) returns uuid
language sql as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, coalesce(new_description, ''), new_key_id) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null) returns void
language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
    description = coalesce(new_description, description), updated_at = now()
  where id = secret_id
$$;
revoke all on schema vault from public;
revoke all on all tables in schema vault from public;
revoke all on all functions in schema vault from public;

-- pg_net stub (pg_net is not packaged for this host)
create schema net;
create table net.http_request_queue (
  id bigserial primary key, method text, url text, headers jsonb, body jsonb,
  timeout_milliseconds int, created_at timestamptz default now()
);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds) returning id
$$;

-- realtime stub
create schema realtime;
create table realtime.messages (
  id bigserial primary key, topic text not null, extension text not null default 'broadcast',
  payload jsonb, event text, private boolean default true, inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant usage on schema realtime to anon, authenticated, service_role;
grant select, insert on realtime.messages to anon, authenticated, service_role;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql as $$
  insert into realtime.messages (topic, payload, event, private) values (topic, payload, event, private)
$$;
grant execute on all functions in schema realtime to anon, authenticated, service_role;

create publication supabase_realtime;

-- storage stub (bucket rows only)
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false);
