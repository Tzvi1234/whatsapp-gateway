# WhatsApp Gateway: Delivery Plan & Task Breakdown (v0.1, Dev Manager)

Gate 0: Tzvi approves ARCHITECTURE.md + brief + the 9 open decisions. Nothing below starts before that (no repo, no code). Week numbers count from approval (W1 = first week after approval).
Rules: branch + PR + tests always; Code Designer review -> Vercel preview -> Product Reviewer -> QA. No merge to main / prod deploy without Tzvi.

## M0 Spike & setup (W1)
| # | Task | Owner | Depends | Done when |
|---|---|---|---|---|
| 0.1 | Create repo Tzvi1234/whatsapp-gateway (monorepo skeleton, CI: typecheck, lint, tests, gitleaks, audit, baileys pin) | Developer + Code Designer | Gate 0 | CI green on empty skeleton |
| 0.2 | Supabase `gateway-dev` project, region per Tzvi | Developer | Gate 0 | project + migrations dir |
| 0.3 | Baileys 7.0.0-rc spike on test number: pairing, LID, reconnect, 72h stability; ADR-Baileys result | Developer (Coder assists on server) | test number | ADR written: 7.x or 6.7.24 |
| 0.4 | STT spike: faster-whisper int8 + ivrit-ai turbo-ct2 on htz-home-01, peak RAM, RTF on real Hebrew voice notes; verify user cgroup memory controller | Developer + Coder | server access | numbers posted; transcriber MemoryMax + high OOMScoreAdjust, worker MemoryLow |
| 0.5 | Lia webhook spike: latency, wrong-key response codes, burst/rate limits | Developer + Lia | routine URL+key from Tzvi | status mapping confirmed |
| 0.6 | TEST-PLAN.md from locked architecture + QA regression map | QA | Gate 0 | plan reviewed by Code Designer |
| 0.7 | Design v3: close Lia-channel gaps; Reviewer sign-off | UI/UX Designer | - | Reviewer approves lia.html |

## M1 Core (W2-W3)
| 1.1 | Schema + RLS + Vault + pgTAP tests (accounts, queue, messages, audit log append-only, tokens) | Developer | 0.2 |
| 1.2 | packages/core + policy (assertChatAllowed, may_initiate, sender allowlist, outbound-url-guard) | Developer | 0.1 |
| 1.3 | Worker: BaileysSession (DB auth state, AES-GCM, getMessage, cacheable key store), queue via Realtime + polling, heartbeat | Developer | 0.3, 1.1 |
| 1.4 | Cloud API adapter on Vercel + signed webhook | Developer | 1.1 |
| 1.5 | MCP v1 compat (12 tools) + send_message extension + send_media/get_message, scoped keys, client_msg_id idempotency | Developer | 1.2 |
| 1.6 | Port automations (matcher/policy/reply/status) with their tests | Developer | 1.2 |
| 1.7 | Heartbeat alert: pg_cron + Edge Function mail (down once, up once) | Developer | 1.1 |
| 1.8 | Cloud API retry/backoff scheduler on pg_cron (every minute), not Vercel Cron | Developer | 1.4 |
QA: regression areas 2-4 + security (SSRF, scopes, RLS) on each PR.

## M2 Dashboard (W3-W4)
| 2.1 | Supabase Auth + MFA login | Developer | 1.1 |
| 2.2 | Home (direction C) + metrics row + all-OK state | Developer | 0.7 |
| 2.3 | Connect flow (provider choice, QR live, Cloud creds with instant token check) | Developer | 1.3, 1.4 |
| 2.4 | Number detail page (24h bar, per-provider metrics) | Developer | 1.3 |
Checkpoint: Product Reviewer on every preview, then QA (regression area 5, RTL, mobile).

## M3 Lia channel (W4-W5)
| 3.1 | Inbound pipeline: normalizeJid, sender-guard, debounce 4s + typing, batch to Supabase | Developer | 1.3 |
| 3.2 | Transcriber service (systemd --user, model resident), zipformer fallback, Soniox behind off flag, >1 min ack to Tzvi | Developer + Coder | 0.4 |
| 3.3 | Agent relay: signed POST to Lia routine, is_test, resend same batch_id, statuses incl. delivery_failed, untested | Developer | 3.1, 0.5 |
| 3.4 | Lia setup screen + status card + allowlist with confirm + audit log view | Developer | 0.7, 3.3 |
| 3.5 | Retention job + signed short-lived media/"play source" links | Developer | 1.1 |
| 3.6 | Metrics view v_transcript_latency (by recording length) on Health page | Developer | 3.2 |
Checkpoint: Reviewer + QA, then live trial with Lia on test number.

## M4 Migration rehearsal (W6)
| 4.1 | Export/transform/load script SQLite -> Supabase with per-row SHA-256 diff report (separate PR) | Developer + Coder | M1 |
| 4.2 | Full cutover rehearsal on test number, run several hours, then rollback test | Developer + QA + Coder | 4.1 |
QA go/no-go to Dev Manager -> PM -> Tzvi.

## M5 Cutover (W7, only with Tzvi's explicit approval)
Runbook §9.3: stop+disable old unit -> snapshot -> migrate -> start gateway-worker -> QR pair -> smoke tests -> 24h monitor -> retire port 8742. Known risk: rollback after connect may need one QR rescan.

## Estimate
About 7 weeks from approval, given one Developer working through cloud agents. Critical path: Gate 0 -> 0.3 Baileys spike (72h) -> 1.3 worker -> 3.x Lia channel -> 4.2 rehearsal.
Blocking inputs from Tzvi: test number, Lia number, Lia routine URL + sender key, Supabase region, alert email, domain.

## Update 2026-10-21 13:25 (PM / Tzvi decisions)
- Numbers/WABA: Tzvi connects them himself via the UI; no longer a blocker.
- **Baileys 72h spike (0.3) starts NOW** via a terminal QR/pairing-code worker script on htz-home-01 (no dashboard, no Supabase; local SQLite/JSONL logging incl. Optimizer baseline metrics). Coder relays the QR/code to Tzvi. Clock starts at first pairing. Re-pair later via the connect screen.
- **Connect screen moves from M2 to M0** (task 0.8): Baileys live QR + pairing code; Cloud API fields (Phone Number ID, WABA ID, Access Token, App Secret, Verify Token) with live server-side validation, Vault-only secrets (last 4 shown), webhook URL copy; QR only for owner after MFA; Lia allowlist seeded with Tzvi's number (from config `LIA_ALLOWLIST_SEED`, never in the repo); 05x -> E.164 shown corrected, not as an error. Designer updates connect.html first (Reviewer re-checks only that).
- Reviewer's 2 remaining fixes (no technical tags in status-card headers; median transcription latency by length on number-lia.html) go into M2 code. Design locked.
- Supabase: local in M0. Cloud project for the connect-screen preview needs Tzvi's decision (Pro ~$25/mo, pause a project, or a separate schema in an existing project for dev only); PM is asking him now. **This blocks the 0.8 preview.**
- Branch rule: feat/*, spike/*, docs/*, fix/* only; CI job alerts on any non-PR push to main.
- 0.2 Supabase cloud `gateway-dev` -> replaced by local Supabase until decided.
