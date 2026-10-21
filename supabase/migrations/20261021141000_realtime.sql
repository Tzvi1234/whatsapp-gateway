-- Realtime (ARCH §2, §4.2, §4.5; ADR-2).
--
-- 1. postgres_changes publication (RLS-checked per subscriber):
--      outbound_queue, session_commands, pairing_requests  -> worker (gateway_worker)
--      sessions, pairing_qr                                -> dashboard (member / owner+AAL2)
-- 2. Private broadcast channels for the dashboard, authorised by RLS on realtime.messages:
--      org:<org_id>:sessions   members (AAL2)   session/connection changes
--      org:<org_id>:alerts     members (AAL2)   new alerts
--      org:<org_id>:pairing    owner (AAL2)     live QR / pairing code
-- Guarded so the migration also applies where the realtime schema is absent.

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['outbound_queue', 'session_commands', 'pairing_requests', 'sessions', 'pairing_qr'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end
$$;

-- Topic authorisation helper: 'org:<uuid>:<channel>'.
create or replace function public.realtime_topic_allowed(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_topic, ''), ':');
  v_org uuid;
begin
  if cardinality(v_parts) <> 3 or v_parts[1] <> 'org' then
    return false;
  end if;
  v_org := public.try_uuid(v_parts[2]);
  if v_org is null then
    return false;
  end if;
  if v_parts[3] = 'pairing' then
    return public.is_owner(v_org);
  elsif v_parts[3] in ('sessions', 'alerts') then
    return public.is_member(v_org);
  end if;
  return false;
end
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists gateway_dashboard_receive on realtime.messages';
    execute $p$
      create policy gateway_dashboard_receive on realtime.messages
        for select to authenticated
        using (public.realtime_topic_allowed((select realtime.topic())))
    $p$;
  end if;
end
$$;

-- Broadcast triggers (best effort: never block the write if Realtime is unavailable).
create or replace function public.realtime_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_channel text := tg_argv[0];
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  begin
    if tg_table_name = 'pairing_qr' and tg_op = 'DELETE' then
      v_row := jsonb_build_object('org_id', v_row -> 'org_id', 'request_id', v_row -> 'request_id',
                                  'account_id', v_row -> 'account_id');
    end if;
    execute 'select realtime.send($1, $2, $3, true)'
      using jsonb_build_object('op', tg_op, 'table', tg_table_name, 'row', v_row),
            lower(tg_table_name || '.' || tg_op),
            'org:' || (v_row ->> 'org_id') || ':' || v_channel;
  exception when others then
    raise warning 'realtime broadcast failed: %', sqlerrm;
  end;
  return null;
end
$$;

create trigger sessions_broadcast after insert or update on public.sessions
  for each row execute function public.realtime_broadcast('sessions');
create trigger alerts_broadcast after insert or update on public.alerts
  for each row execute function public.realtime_broadcast('alerts');
create trigger pairing_qr_broadcast after insert or update or delete on public.pairing_qr
  for each row execute function public.realtime_broadcast('pairing');
