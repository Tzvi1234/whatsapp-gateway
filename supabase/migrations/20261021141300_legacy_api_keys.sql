-- Legacy WhatsApp-Automation agent tokens (TEST-PLAN R3.3): imported as SHA-256 hashes with no
-- `gw_<prefix>_` prefix, so they cannot be looked up by prefix. key_prefix becomes nullable for
-- legacy rows only, and the server looks them up by hash.

alter table public.api_clients alter column key_prefix drop not null;
alter table public.api_clients
  add constraint api_clients_prefix_or_legacy check (key_prefix is not null or legacy);
create unique index if not exists api_clients_legacy_hash_uq
  on public.api_clients (key_hash) where legacy;

create or replace function public.lookup_legacy_api_client(p_key_hash text)
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
  where c.legacy
    and c.key_prefix is null
    and c.key_hash = lower(p_key_hash)
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
$$;

revoke execute on function public.lookup_legacy_api_client(text) from public, anon, authenticated, gateway_worker;
grant execute on function public.lookup_legacy_api_client(text) to service_role;
