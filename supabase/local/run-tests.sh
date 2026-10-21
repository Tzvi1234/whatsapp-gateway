#!/usr/bin/env bash
# Run migrations + pgTAP against a plain PostgreSQL (no Docker) using a minimal Supabase shim.
# For local dev only; CI uses the real `supabase start` + `supabase test db`.
# Requires: psql, pg_prove, pgTAP and pg_cron installed in the target cluster.
# Usage: PGHOST=127.0.0.1 PGUSER=postgres supabase/local/run-tests.sh [test [files...]]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DB=${GW_TEST_DB:-gw_test}
export PGHOST=${PGHOST:-127.0.0.1} PGUSER=${PGUSER:-postgres}
psql -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
# roles are cluster-wide: drop leftovers from previous runs
for r in gateway_worker authenticator anon authenticated service_role supabase_admin; do
  psql -q -d postgres -c "do \$\$ begin if exists (select 1 from pg_roles where rolname='$r') then execute 'drop owned by $r cascade'; execute 'drop role $r'; end if; end \$\$;" >/dev/null 2>&1 || \
  (psql -q -d "$DB" -c "drop owned by $r cascade" >/dev/null 2>&1; psql -q -d postgres -c "drop role if exists $r" >/dev/null)
done
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$REPO/supabase/local/supabase-shim.sql"
for f in "$REPO"/supabase/migrations/*.sql; do
  echo "== $(basename "$f")"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
echo "== seed.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$REPO/supabase/seed.sql"
if [ "${1:-}" = "test" ]; then
  shift
  pg_prove -d "$DB" ${@:-"$REPO"/supabase/tests/*.sql}
fi
