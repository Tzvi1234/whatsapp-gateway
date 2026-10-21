# scripts/migrate: WhatsApp-Automation → Gateway data migration

This package exports the legacy SQLite DB (`data/whatsapp-automation.sqlite` on htz-home-01),
transforms it, loads it into the Supabase Postgres schema (`supabase/migrations`) with
idempotent upserts, and checks the result with a per-row SHA-256 diff report. It implements
ARCHITECTURE.md §9.3 steps 1–5 and TEST-PLAN M1, M2 and M4.

> **The legacy schema is an assumption.** The legacy repo was not available when this was written.
> `src/legacy-schema.ts` documents the ASSUMED tables and columns. **Always run `inspect`
> first.** If it shows any missing, extra or mismatched column, adjust `legacy-schema.ts` and
> `transform.ts`, re-run the tests, and only then continue.

## Commands

```bash
pnpm -C scripts/migrate migrate <command> [flags]

inspect --sqlite <path> [--json]       # real schema, row counts, diff vs the assumed schema
plan    --sqlite <path> --org <uuid> --baileys-account <uuid> --cloud-account <uuid> [--database-url <url>]
load    ...same as plan... [--accept-rejects]
verify  ...same as plan...
```

| Flag | Meaning |
|---|---|
| `--sqlite` | Legacy DB. Opened with `readonly: true, fileMustExist: true` and `PRAGMA query_only`. The tool never modifies it. |
| `--database-url` / env `DATABASE_URL` | Service connection to Supabase Postgres (the `postgres` user from the project's connection string, `sslmode=require`). RLS does not apply to it. `plan` can run without it (offline summary). |
| `--org` | Target `orgs.id`. It must already exist. |
| `--baileys-account` | `accounts.id` for legacy slot `default`. Created (alias `default`, provider `baileys`) if missing. |
| `--cloud-account` | `accounts.id` for legacy slot `meta-default`. Created (alias `meta-default`, provider `meta_cloud`) if missing. |
| `--since-days` | Window for `chat_messages` and terminal reminders (default 30). |
| `--now` | Pin "now" (ISO) so `plan`, `load` and `verify` use the same window. **Use the same value for every step of a run.** |
| `--report-dir` | Where `plan-*.md/json`, `load-*.md/json` and `verify-*.md/json` go (default `./migrate-reports`). |
| `--accept-rejects` | `load` refuses to run while any source row is rejected or a legacy table is missing. Pass this only after QA has reviewed the reject list. |

Exit codes: `0` ok · `1` error, or `verify` found differences · `2` load refused (rejects) · `64` usage.

Output and reports contain counts, ids, table and column names, and reject reasons
(`table`, `rowid`, `invalid:<column>:<code>`). They never contain message bodies, tokens or
hashes, or phone numbers. `inspect` shows categorical values (such as states or slot ids) only
when every value is a short token without long digit runs.

## What is migrated

| Legacy (assumed) | Target | Rules |
|---|---|---|
| `linked_accounts` | `accounts` | `default` → Baileys id, `meta-default` → Cloud id. Label and phone (E.164) are set on insert only, so existing accounts keep theirs. |
| `settings` | `accounts.pacing` (Baileys) | `daily_cap`→`dailyCap`, `min_delay_ms`→`minDelayMs`, `max_delay_ms`→`maxDelayMs`, `timezone`. Other keys are reported as `unmapped_setting:<key>`. |
| `statuses` | `statuses` | `wa_status_id` → `provider_status_id`, `legacy_id` kept |
| `automations` | `automations` | Same matching config. A dangling `status_id` is nulled with a warning. |
| `cooldowns` | `automation_cooldowns` | `contact_key` = normalised JID (`normalizeJid`) |
| `contact_aliases` | `contacts` | PN JID → `pn_jid`, LID → `lid`; a duplicate identity is rejected |
| `reminders` | `reminders` | Non-terminal rows always, terminal rows only inside the window. UUID ids are **kept**; other ids get a deterministic id and keep `legacy_id`. State is kept (`pending` → `scheduled`); `unconfigured` stays retryable (M4). |
| `agent_tokens` | `api_clients` | Hash only, `legacy = true`, all 7 legacy scopes, both accounts. See the note on `key_prefix` below. |
| `chat_messages` | `conversations` + `messages` | Last N days. Inbound → `delivered`. Unsent outbound (`pending`/`queued`) → `failed`, `error_code = legacy_unsent`. |

- **Deterministic ids**: UUID v5 of `org:table:legacy id` in a fixed namespace
  (`transform.ts`), so every re-run targets the same rows (M1).
- **Upserts**: `ON CONFLICT (id) DO UPDATE ... WHERE <owned columns> IS DISTINCT FROM ...`.
  A second run with the same snapshot writes **nothing** (`unchanged` = all rows).
- **Transactions**: one transaction per table, in FK order. `plan` with a DB runs everything in
  one transaction and rolls it back, so it shows exact insert/update counts.
- **Preflight** (aborts before any write): unknown org; mapped account in another org or with the
  wrong provider; id already used by another org; natural-key collision with a row this
  migration did not create (for example a conversation the new worker already created).
- **Audit**: each real `load` appends one `audit_log` row through `audit_append`
  (`actor_type = system`, `action = legacy_migration.load`). The meta holds the source file
  sha256, the window and per-table counts.
- **`api_clients.key_prefix`**: legacy tokens should have `key_prefix = null`
  (`packages/mcp/src/auth.ts` looks them up by hash). The current schema still has
  `key_prefix NOT NULL`, so the loader checks the column. If it is nullable it writes `null`.
  Otherwise it writes the sentinel `legacy-<target id>`, which can never match a real
  `gw_<8 alnum>_` prefix. A DB lookup by hash for legacy keys is still needed on the server side.
- **Media files** are not copied by this tool. `media_path` values are kept as they are. Copy
  `data/media` to Storage separately if needed (ARCH §9.3 step 2).
- **Do not re-run `load` after the new worker has started.** It would reset runtime-owned
  columns such as reminder state and conversation timestamps to the snapshot.

## Runbook: rehearsal on the test number (M4/M5), run by Coder on htz-home-01

1. **Freeze** the old service. Stop the scheduler and keep it read-only, then stop **and
   disable** it:
   `systemctl --user stop whatsapp-automation && systemctl --user disable whatsapp-automation`.
   Confirm that port 8742 no longer answers.
2. **Snapshot**:
   `sqlite3 data/whatsapp-automation.sqlite ".backup /home/deploy/migrate/legacy-$(date +%F).sqlite"`.
   Store an encrypted offline copy of the snapshot together with `data/baileys-auth`. **All
   following steps use the snapshot, never the live file.**
3. **Inspect**: `pnpm -C scripts/migrate migrate inspect --sqlite <snapshot>`. Check:
   - no assumed tables or columns are missing, and no unexpected tables appear;
   - timestamp columns report `seconds=0` (if they show seconds, change the mapping to ×1000);
   - the categorical values (`state`, `bind_mode`, `slot`, `type`, settings keys) are covered by
     `legacy-schema.ts`.
4. **Adjust the mapping** if needed (`legacy-schema.ts`, `transform.ts`), then run
   `pnpm vitest run scripts/migrate`, open a PR, and get it reviewed before going on.
5. **Plan**. Fix `NOW=$(date -u +%FT%TZ)` once and reuse it:
   `migrate plan --sqlite <snapshot> --org … --baileys-account … --cloud-account … --now $NOW --report-dir <dir>`.
   Review the rejects and warnings (by table and rowid) with QA. Every reject is either fixed in
   the mapping or explicitly accepted.
6. **Load**: `migrate load … --now $NOW [--accept-rejects]`. Optionally run it a second time: it
   must report `insert 0, update 0` for every table (M1).
7. **Verify**: `migrate verify … --now $NOW`. The exit code must be 0 and every table must show
   `matched = source rows` with equal digests (M2). Attach `verify-*.md` to the QA ticket.
8. **QA sign-off**: spot-check 5 automations end-to-end on the test number (M3) and check that
   reminders keep their ids and that `unconfigured` ones are retried (M4). Existing Grok Bot
   configs only change the URL. Then start `gateway-worker` and pair with a QR scan. The old
   service must stay disabled (never both connected).
9. **Rollback notes**:
   - *Before the new worker connects*: stop the worker, then re-enable and start
     `whatsapp-automation`. The SQLite file was never modified. Migrated rows can stay (they
     are inert) or be removed by id from `load-*.json`.
   - *After the new worker connected*: the old auth state may be stale, so plan for one QR
     rescan (ARCH §9.3). Write down whether a rescan was needed (M6).
   - `audit_log` rows are append-only and stay.

## Tests

```bash
pnpm vitest run scripts/migrate                       # unit tests (fixture SQLite, no DB)
MIGRATE_TEST_DATABASE_URL=postgres://… pnpm vitest run scripts/migrate   # + end-to-end
```

The integration test needs a Postgres database with `supabase/migrations` applied. Without
Docker, also apply the Supabase shim described in `docs/database.md` §9. Each run uses a fresh
random org. It covers: load refused while rows are rejected; a dry run writes nothing; load,
then a second load changes nothing; verify is clean; reminders keep their ids and state; legacy
api_clients rows are correct; tampering is detected by id and column, and a re-load repairs it;
one audit row per load with a valid chain; preflight aborts on a wrong-provider account.
