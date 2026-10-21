-- S9 private media bucket + policies, S11 media purge queue consumer.
begin;
set local client_min_messages = warning;
select * from no_plan();
select tests.create_fixture();

select is((select public from storage.buckets where id = 'media'), false, 'S9 media bucket exists and is private');

create temp table p on commit drop as
select tests.id('org_a')::text || '/' || tests.id('acc_a')::text || '/WAIN0001' as ok_path,
       tests.id('org_b')::text || '/x/WAIN0001' as other_org_path;

-- gateway_worker: insert + select under an org prefix.
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format($s$insert into storage.objects (bucket_id, name) values ('media', %L)$s$, (select ok_path from p))), 'ok:1',
  'S9 worker uploads under its org prefix');
insert into storage.objects (bucket_id, name) values ('media', (select ok_path from p));
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}', $s$select * from storage.objects where bucket_id = 'media'$s$),
  'ok:1', 'S9 worker reads media under org prefixes');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  $s$insert into storage.objects (bucket_id, name) values ('media', 'not-an-org/x/y')$s$), 'err:42501',
  'S9 worker cannot write outside an org prefix');
select is(tests.try_sql('gateway_worker', jsonb_build_object('role', 'gateway_worker', 'org_id', tests.id('org_a')),
  format($s$insert into storage.objects (bucket_id, name) values ('media', %L)$s$, (select other_org_path from p))),
  'err:42501', 'S9 worker JWT org_id claim restricts the prefix');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format($s$insert into storage.objects (bucket_id, name) values ('media', %L)$s$,
    tests.id('org_a')::text || '/../x')), 'err:42501', 'S9 path traversal rejected');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  format($s$update storage.objects set name = name where bucket_id = 'media'$s$)), 'err:42501',
  'S9 worker cannot update objects');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}',
  $s$delete from storage.objects where bucket_id = 'media'$s$), 'err:42501', 'S9 worker cannot delete objects');

-- Dashboard users and anon: nothing (signed URLs only).
select is(tests.try_sql('authenticated', tests.claims('owner_a'), $s$select * from storage.objects where bucket_id = 'media'$s$),
  'ok:0', 'S9 authenticated users read no media objects');
select is(tests.try_sql('authenticated', tests.claims('owner_a'),
  format($s$insert into storage.objects (bucket_id, name) values ('media', %L)$s$, (select ok_path from p) || 'b')),
  'err:42501', 'S9 authenticated users cannot upload media');
select is(tests.try_sql('anon', '{"role": "anon"}', $s$select * from storage.objects$s$), 'ok:0', 'S9 anon reads nothing');

-- service_role: full access.
select is(tests.try_sql('service_role', '{"role": "service_role"}',
  $s$delete from storage.objects where bucket_id = 'media'$s$), 'ok:1', 'S9 service_role has full access');

-- S11: purge queue consumer.
select is(public.media_purge_due(), true, 'S11 queued media makes the purge due');
create temp table cl on commit drop as select * from public.media_purge_claim(100);
select is((select count(*)::int from cl), 1, 'S11 purge claims the queued object');
select is((select count(*)::int from public.media_purge_claim(100)), 0, 'S11 leased rows not re-claimed');
select is(public.media_purge_ack(array(select id from cl), 'storage 503'), 1, 'S11 failure recorded');
select is((select count(*)::int from public.media_purge_claim(100)), 1, 'S11 failed purge retried');
select is(public.media_purge_ack(array(select id from cl)), 1, 'S11 ack after Storage API removal');
select is(public.media_purge_due(), false, 'S11 nothing left to purge');
select is((select schedule from cron.job where jobname = 'gw-media-purge'), '*/10 * * * *', 'S11 purge scheduled by pg_cron');
select is(tests.try_sql('gateway_worker', '{"role": "gateway_worker"}', $s$select * from public.media_purge_claim(1)$s$),
  'err:42501', 'S11 only the server purges');

select * from finish();
rollback;
