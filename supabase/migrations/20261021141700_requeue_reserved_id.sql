-- RL2 with pre-generated Baileys ids: the worker reserves the WhatsApp id (job_reserve_provider_id)
-- BEFORE sending. A message that then failed permanently still carries that reserved (never
-- confirmed) id, so "Resend" must accept it: only a CONFIRMED send (sent_at set) blocks a resend.
-- The re-claimed job comes back with the reserved id; the worker checks its sent-message store and
-- resends with the same id (WhatsApp dedupes by id) or completes.
create or replace function public.message_requeue(p_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
  a public.accounts%rowtype;
  v_job uuid;
begin
  select * into m from public.messages where id = p_message_id for update;
  if not found or m.direction <> 'out' then
    raise exception 'outbound message % not found', p_message_id using errcode = 'P0002';
  end if;
  if m.status not in ('failed', 'cancelled') or m.sent_at is not null
     or (m.provider_message_id is not null and m.account_id not in
         (select x.id from public.accounts x where x.provider = 'baileys')) then
    raise exception 'message % is not resendable (status %)', p_message_id, m.status using errcode = '55000';
  end if;
  select * into a from public.accounts where id = m.account_id;
  update public.messages set status = 'queued', error_code = null, failed_at = null where id = m.id;
  insert into public.outbound_queue (org_id, message_id, account_id, conversation_id, executor)
  values (m.org_id, m.id, m.account_id, m.conversation_id,
          case a.provider when 'baileys' then 'worker' else 'edge' end)
  returning id into v_job;
  return v_job;
end
$$;
