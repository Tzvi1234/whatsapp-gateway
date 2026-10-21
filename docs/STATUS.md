# Implementation status (2026-10-21)

Branch: `claude/eloquent-meitner-o4ik2s`. Nothing merged to `main`, nothing deployed, no paid services,
no messages sent (hard rules).

## Built (M0–M4 code)
| Plan task | Where | Verified here |
|---|---|---|
| 0.1 skeleton + CI | root, `.github/workflows/` | typecheck, lint (boundaries), prettier, vitest, pin check |
| 0.3 Baileys 7 spike worker | `spikes/baileys7/`, runbook `docs/spike-baileys7.md` | unit tests, bundle; **not run against WhatsApp** |
| 0.8 / 2.3 connect screen | `apps/web/src/app/(owner)/connect` | build + fixture screenshots `docs/design/impl/` |
| 1.1 schema, RLS, Vault, pgTAP | `supabase/` | 932 pgTAP assertions on PG16 + shim (`supabase/local/run-tests.sh test`) |
| 1.2 core + policy | `packages/core`, `packages/policy` | unit tests (send gate, SSRF guard, allowlist) |
| 1.3 worker | `apps/worker` | unit tests with fakes, bundle; **not run against Supabase** |
| 1.4 Cloud adapter + webhook | `packages/providers/cloud`, `apps/web/src/app/api/meta/webhook` | unit tests with fixtures |
| 1.5 MCP (12 legacy + new tools) | `packages/mcp`, `apps/web/src/app/mcp` | unit tests, tools snapshot |
| 1.6 automations | `packages/automations` | unit tests (reimplemented from spec) |
| 1.7 heartbeat alert | `supabase/functions/heartbeat-alert` + pg_cron | Deno tests, pgTAP |
| 1.8 Cloud retry on pg_cron | `supabase/functions/cloud-retry`, `/api/internal/cloud-send` | unit tests |
| 2.1–2.4 dashboard | `apps/web/src/app`, `src/ui` | build, fixture screenshots |
| 3.1–3.6 Lia channel | `packages/relay`, worker inbound, `/api/internal/deliver`, Lia screens, `services/transcriber` | unit + pgTAP |
| 4.1 migration script | `scripts/migrate` | integration test on PG16 (load twice = no change, verify clean) |

Totals at last run: 763 vitest tests, 932 pgTAP assertions, 6 transcriber tests, `next build`, worker and spike bundles.

## Needs Tzvi / the server (cannot be done from the repo)
1. **Make the GitHub repo private** (it is currently public) and protect `main`.
2. Decide the Supabase cloud dev project (Pro / pause a project / separate schema). Blocks the Vercel preview.
3. Run the 72h Baileys spike on htz-home-01 with the test number (`docs/spike-baileys7.md`), fill ADR-5.
4. STT spike 0.4 on htz-home-01 (`services/transcriber/README.md`): cgroup memory check, peak RSS, RTF, WER.
5. Lia routine webhook URL + sender key (spike 0.5: wrong-key response codes, latency); add the domain to `RELAY_ALLOWED_HOSTS`.
6. Run `pnpm -C scripts/migrate migrate inspect --sqlite <path>` read-only on the server and adjust `scripts/migrate/src/legacy-schema.ts` (the legacy repo was not accessible, so the schema is assumed).
7. Compare the frozen MCP v1 tool snapshot (`packages/mcp/src/__snapshots__/`) with the real WA-Automation `docs/mcp.md`; confirm legacy token hashing (assumed unsalted SHA-256 hex).
8. Env/secrets: `apps/web/.env.example`, `apps/worker/README.md`, Edge Function env in `docs/database.md`, Vault secrets `edge_base_url`, `edge_cron_secret`.
9. M4 rehearsal + rollback on the test number, then M5 cutover only with explicit approval.

## Known open items
- Reimplemented (not ported) automations and MCP v1 params: R1.11 cannot be checked until the legacy source is available.
- Fonts (Rubik, IBM Plex Mono) need self-hosting; system fonts used for now.
- Turnstile widget needs a site-key env var.
- Status-post media is not queued for purge by retention.
- Everything that talks to live Supabase, Vercel, Meta, WhatsApp or Lia is untested until the environments exist.
