-- S11 retention with time-shifted fixtures; L6.4 audit never purged.
begin;
set local client_min_messages = warning;
select plan(14);
select tests.create_fixture();

-- Time-shift: one old inbound (91d), one 31d-old media message, one fresh.
update public.messages set created_at = now() - interval '91 days', transcript = 'old transcript'
 where provider_message_id = 'WAIN0001';
update public.messages set created_at = now() - interval '31 days', media_path = 'media/in/2.jpg'
 where provider_message_id = 'WAIN0002';
update public.inbound_events set received_at = now() - interval '8 days' where dedupe_key like '%WAIN0001';
insert into public.worker_logs (org_id, worker_id, level, msg, at)
values (tests.id('org_a'), 'worker-a', 'info', 'old', now() - interval '8 days');
update public.inbound_events set raw = '{"fresh": true}' where dedupe_key like '%WAIN0002';
create temp table before on commit drop as
  select (select count(*) from public.audit_log) as audit, (select max(seq) from public.audit_log) as max_seq;

select ok((public.retention_run() ->> 'bodies')::int >= 1, 'S11 retention ran');
select results_eq($s$select body, transcript from public.messages where provider_message_id = 'WAIN0001'$s$,
  $s$values (null::text, null::text)$s$, 'S11 body + transcript older than 90 days purged');
select is((select media_path from public.messages where provider_message_id = 'WAIN0001'), null, 'S11 old media path purged');
select is((select body from public.messages where provider_message_id = 'WAIN0002'), 'second', 'S11 31-day body kept');
select is((select media_path from public.messages where provider_message_id = 'WAIN0002'), null, 'S11 media older than 30 days purged');
select ok(exists (select 1 from public.media_purge_queue where path in ('media/in/1.ogg', 'media/in/2.jpg')),
  'S11 media files queued for Storage deletion');
select is((select body from public.messages where idempotency_key = 'k-1'), 'hi there', 'S11 fresh message untouched');
select is((select raw from public.inbound_events where dedupe_key like '%WAIN0001'), null, 'S11 raw webhook payload >7d purged');
select isnt((select raw from public.inbound_events where dedupe_key like '%WAIN0002'), null, 'S11 fresh raw payload kept');
select is((select count(*)::int from public.worker_logs where msg = 'old'), 0, 'S11 worker logs >7d deleted');
select is((select count(*)::int from public.worker_logs where msg = 'fixture'), 1, 'S11 fresh worker logs kept');
select is((select count(*) from public.audit_log), (select audit from before), 'L6.4 retention never deletes audit rows');
select ok((select ok from public.audit_verify_chain()), 'L6.4 audit chain intact after retention');
select ok(position('audit_log' in pg_get_functiondef('public.retention_run(int, int, int, int)'::regprocedure)) = 0,
  'L6.4 retention function never references audit_log');

select * from finish();
rollback;
