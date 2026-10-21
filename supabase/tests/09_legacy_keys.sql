begin;
select plan(5);

insert into public.orgs (id, name) values ('00000000-0000-0000-0000-00000000f001', 'legacy-test');

-- sha256('legacy-token-fixture')
select lives_ok($$
  insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, legacy)
  values ('00000000-0000-0000-0000-00000000f001', 'legacy', null,
          encode(extensions.digest('legacy-token-fixture', 'sha256'), 'hex'), '{messages:send}', true)
$$, 'R3.3 legacy key may have a null prefix');

select throws_ok($$
  insert into public.api_clients (org_id, name, key_prefix, key_hash, scopes, legacy)
  values ('00000000-0000-0000-0000-00000000f001', 'new', null, repeat('a', 64), '{messages:send}', false)
$$, '23514', null, 'R3.3 non-legacy key must have a prefix');

select is((select count(*)::int from public.lookup_legacy_api_client(
  encode(extensions.digest('legacy-token-fixture', 'sha256'), 'hex'))), 1,
  'R3.3 legacy key found by hash');

select is((select count(*)::int from public.lookup_legacy_api_client(repeat('b', 64))), 0,
  'R3.3 unknown hash not found');

select ok(not has_function_privilege('authenticated', 'public.lookup_legacy_api_client(text)', 'execute'),
  'S6 dashboard users cannot call the legacy lookup');

select * from finish();
rollback;
