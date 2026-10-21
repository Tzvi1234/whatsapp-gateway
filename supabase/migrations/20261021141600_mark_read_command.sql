-- MCP `mark_read` on Baileys accounts: a worker command (the socket lives on htz-home-01).
-- session_commands gains command 'mark_read' with payload {"chat": "<jid>", "ids": ["<provider id>", ...]}.

alter table public.session_commands add column payload jsonb;
alter table public.session_commands drop constraint session_commands_command_check;
alter table public.session_commands add constraint session_commands_command_check
  check (command in ('reconnect', 'logout', 'pair', 'mark_read'));
alter table public.session_commands add constraint session_commands_mark_read_payload check (
  command <> 'mark_read' or coalesce(
    jsonb_typeof(payload -> 'chat') = 'string'
    and jsonb_typeof(payload -> 'ids') = 'array'
    and jsonb_array_length(payload -> 'ids') between 1 and 100, false));

-- Server (MCP) → worker. Not audited per call (the MCP layer audits the tool call).
create or replace function public.request_mark_read(p_account_id uuid, p_chat text, p_ids text[],
  p_via text default 'mcp')
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
  if coalesce(p_chat, '') = '' or length(p_chat) > 128 or p_ids is null or cardinality(p_ids) = 0
     or cardinality(p_ids) > 100
     or exists (select 1 from unnest(p_ids) x where coalesce(x, '') = '' or length(x) > 128) then
    raise exception 'invalid mark_read request' using errcode = '22023';
  end if;
  insert into public.session_commands (org_id, account_id, command, requested_via, payload)
  values (a.org_id, a.id, 'mark_read', p_via, jsonb_build_object('chat', p_chat, 'ids', to_jsonb(p_ids)))
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function public.request_mark_read(uuid, text, text[], text)
  from public, anon, authenticated, service_role, gateway_worker;
grant execute on function public.request_mark_read(uuid, text, text[], text) to service_role;
