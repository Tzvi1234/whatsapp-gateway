-- Local development seed (supabase db reset). One org, nothing personal.
-- No phone numbers here: the Lia allowlist is seeded at runtime from config
-- (LIA_ALLOWLIST_SEED), never from the repo (CODE-STRUCTURE §7, TEST-PLAN C8).
-- Dashboard users are created through Supabase Auth and linked to the org with an
-- org_members row by the app's bootstrap step.

insert into public.orgs (id, name)
values ('00000000-0000-4000-8000-000000000001', 'H.T.Z Studios (dev)')
on conflict (id) do nothing;
