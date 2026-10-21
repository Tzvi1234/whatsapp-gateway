-- Single allowlist source (TEST-PLAN L6.1, L1.7, L2.1). The send gate reads
-- accounts.use_case_policy.sender_allowlist; the relay channel stores relay_targets.allowed_senders.
-- The DB now keeps the former DERIVED from the latter:
--   * relay_targets.allowed_senders may only change through relay_allowlist_update (audited, L6.1);
--   * any change of a target's allowlist / enabled flag re-derives the account's policy;
--   * a direct write to accounts.use_case_policy cannot set a different sender_allowlist.
-- An enabled relay target also turns on `relay` and allows the `agent_relay` use case (what the
-- web app used to sync by hand). LIA_ALLOWLIST_SEED stays a worker-side merge (config, C8).

-- Union of the enabled targets' allowlists, as a sorted jsonb array.
create or replace function public.relay_allowlist_of(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb)
  from public.relay_targets t, unnest(t.allowed_senders) x
  where t.account_id = p_account_id and t.enabled
$$;

-- Applies the derived allowlist (and relay flags) to a policy document.
create or replace function public.policy_with_relay_allowlist(p_policy jsonb, p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb := coalesce(p_policy, '{}'::jsonb);
  v_uc jsonb;
begin
  if jsonb_typeof(v) <> 'object' then
    return p_policy;  -- malformed: leave it, the gate fails closed
  end if;
  v := v || jsonb_build_object('sender_allowlist', public.relay_allowlist_of(p_account_id));
  if exists (select 1 from public.relay_targets t where t.account_id = p_account_id and t.enabled) then
    v_uc := case when jsonb_typeof(v -> 'allowed_use_cases') = 'array' then v -> 'allowed_use_cases'
                 else '[]'::jsonb end;
    if not v_uc ? 'agent_relay' then
      v_uc := v_uc || '["agent_relay"]'::jsonb;
    end if;
    v := v || jsonb_build_object('relay', true, 'allowed_use_cases', v_uc);
  end if;
  return v;
end
$$;

-- accounts: the stored sender_allowlist is always the derived one.
create or replace function public.accounts_derive_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.use_case_policy := public.policy_with_relay_allowlist(new.use_case_policy, new.id);
  return new;
end
$$;

create trigger accounts_derive_allowlist before insert or update of use_case_policy on public.accounts
  for each row execute function public.accounts_derive_allowlist();

-- relay_targets: allowed_senders only via relay_allowlist_update (flag set for that statement).
create or replace function public.relay_targets_guard_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('gateway.allowlist_write', true), '') = 'on' then
    return new;
  end if;
  if not public.is_e164_array(new.allowed_senders) then
    return new;  -- let the CHECK constraint report the bad value
  end if;
  if (tg_op = 'INSERT' and cardinality(new.allowed_senders) > 0)
     or (tg_op = 'UPDATE' and new.allowed_senders is distinct from old.allowed_senders) then
    raise exception 'allowed_senders can only change through relay_allowlist_update'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger relay_targets_guard_allowlist before insert or update of allowed_senders on public.relay_targets
  for each row execute function public.relay_targets_guard_allowlist();

-- relay_targets change -> re-derive the account policy (touching use_case_policy fires the
-- accounts trigger above).
create or replace function public.relay_targets_sync_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.accounts set use_case_policy = use_case_policy where id = old.account_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id) then
    update public.accounts set use_case_policy = use_case_policy where id = new.account_id;
  end if;
  return null;
end
$$;

create trigger relay_targets_sync_policy
  after insert or delete or update of allowed_senders, enabled, account_id on public.relay_targets
  for each row execute function public.relay_targets_sync_policy();

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
  perform set_config('gateway.allowlist_write', 'on', true);
  update public.relay_targets set allowed_senders = v_new where id = t.id;
  perform set_config('gateway.allowlist_write', 'off', true);
  perform public.audit_append(t.org_id, 'user', p_actor_user_id::text, 'relay_allowlist.update',
    'relay_target:' || t.id, p_ip,
    jsonb_build_object('before', to_jsonb(t.allowed_senders), 'after', to_jsonb(v_new)));
  return v_new;
end
$$;

-- Backfill existing accounts.
update public.accounts set use_case_policy = use_case_policy;

revoke all on function
  public.relay_allowlist_of(uuid),
  public.policy_with_relay_allowlist(jsonb, uuid),
  public.accounts_derive_allowlist(),
  public.relay_targets_guard_allowlist(),
  public.relay_targets_sync_policy()
from public, anon, authenticated, service_role, gateway_worker;
