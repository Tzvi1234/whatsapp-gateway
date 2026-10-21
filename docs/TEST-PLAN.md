# WhatsApp Gateway: Test Plan (v0.1, QA)

Owner: QA Engineer, H.T.Z Studios · Date: 2026-10-21 · Status: v0.2, approved by Code Designer with fixes applied (PLAN task 0.6)
Sources: `ARCHITECTURE.md` v1.0, `contracts/lia-connection-test.md`, `PLAN.md`, QA regression map of `tzvi-weiss/WhatsApp-Automation` (Origin, read-only).

## 0. Principles and gates

- **Never test on a real number.** Every Baileys and Lia test uses the dedicated test number. Cloud API tests use the Meta test number. Production numbers are touched only in M5, with Tzvi's approval.
- **Each PR:** Code Designer review → Vercel preview → Product Reviewer (UI) → QA. QA posts pass/fail per test ID in the PR plus a go/no-go. Bugs go to the Developer with repro steps, expected vs actual, logs and correlation id (`message_id` / `batch_id`).
- **Automated first.** Every test marked [A] must be in CI (unit, pgTAP, or integration against local Supabase (`supabase start`)). [M] means manual or exploratory on the test number, with evidence (screenshot or log) attached to the PR.
- **Naming:** every automated test title starts with its plan ID, e.g. `it("L2.1 …")`, so CI output maps to pass/fail per ID.
- **Severity:** S1 = security, data loss, or message to a wrong recipient (blocks merge). S2 = regression of a preserved behaviour or a silent failure (blocks merge). S3 = degraded UX or metric (fix before cutover). S4 = cosmetic.
- **Go/no-go for cutover (M5):** every S1/S2 test passes, migration diff report is clean, rehearsal plus rollback succeeded on the test number, 72h Baileys stability met.

## 1. Regression: behaviour preserved from WhatsApp-Automation (ARCH §9.3)

### R1 Status-reply automations [A unit on ported `packages/automations` + M on test number]
| ID | Case | Expected |
|---|---|---|
| R1.1 | Bind to a specific status; reply to that status with a matching keyword | One reply in the same direct chat |
| R1.2 | Bind to "next status I post"; post a status within 10 min (notify) | Automation attaches to that status; older statuses are not bound |
| R1.3 | `exact` vs `contains`, case-sensitive and case-insensitive | Matches per mode only |
| R1.4 | Hebrew niqqud in keyword or in reply text | Stripped before match; `ם` ≠ `מ` (final letters stay distinct) |
| R1.5 | `ignoreEmoji` on/off with emoji in text | Matches only per flag |
| R1.6 | `{name}` in reply | Replaced with push name; empty name handled |
| R1.7 | Media attached | Media sent; native buttons not attempted with media |
| R1.8 | 1 to 10 options | Numbered list with safe http(s) links only; an 11th option is rejected by validation |
| R1.9 | Native-button attempt flag | Capability shows `unsupported`/`unverified`; fallback to numbered text and `delivery_mode='fallback'` is logged (no silent failure) |
| R1.10 | Disabled automation | Skipped and logged `skipped_disabled` |
| R1.11 | Ported legacy unit tests (matcher, policy, statusReply, reminders, agent-bridge, time) | All pass unchanged except the LID adaptation in `jid.ts` |

### R2 Protection rules
| ID | Case | Expected |
|---|---|---|
| R2.1 | Status reply from a group or non-direct chat | Ignored (`skipped_not_direct`) |
| R2.2 | Same contact replies twice to the same status | Second one skipped (`skipped_cooldown`), **including when the same person appears once as LID and once as PN** |
| R2.3 | Message older than max age (default 5 min) | Skipped (`skipped_stale`) |
| R2.4 | Daily cap reached (timezone boundary at local midnight) | Skipped (`skipped_cap`); resets the next local day |
| R2.5 | Pacing | Random delay within 1 to 10 s, typing shown for part of it, mark-read, min gap between sends, per-conversation FIFO |
| R2.6 | `may_initiate=false` (status-automation account) | `send_message` to a chat with no inbound message is rejected (`use_case_not_allowed`), from both MCP and the dashboard |
| R2.7 | `may_initiate` exceptions | Lia relay account may message Tzvi first; reminder account may send a reminder; neither can message anyone else |

### R3 MCP v1 compatibility [A integration]
| ID | Case | Expected |
|---|---|---|
| R3.1 | Each of the 12 legacy tools called with **legacy params only**: `list_automations`, `create_automation`, `update_automation`, `delete_automation`, `send_message`, `update_reply`, `get_thread`, `send_reminder`, `list_reminders`, `cancel_reminder`, `session_status`, `session_reconnect` | Same names, params accepted, response is a superset of v1 (snapshot test against v1 fixtures) |
| R3.2 | No `account` param | Resolves to `default` / `meta-default` alias |
| R3.3 | Imported legacy token hash | Authenticates against the new `/mcp`; only the URL changes in the Grok Bot config |
| R3.4 | Scopes: call each tool with a token missing its scope | Rejected; no side effect; audited |
| R3.5 | `send_message` extended form: `reply_to_id`, `client_msg_id` | Works; same `client_msg_id` twice (sequential and **concurrent**) gives one send and the same result |
| R3.6 | `send_message` without `client_msg_id` | Works without dedup and is logged as such |
| R3.7 | stdio mode | Not available (dropped) and documented |
| R3.8 | `session_status` output | Never contains QR, auth state, tokens or secrets |

### R4 Cloud API reminders [A + M on Meta test number]
| ID | Case | Expected |
|---|---|---|
| R4.1 | Text reminder inside the 24h window | Sent |
| R4.2 | Outside the window without a template | Rejected `outside_24h_window` with action "use send_template" |
| R4.3 | Utility template outside the window | Sent |
| R4.4 | Missing Meta credentials | State `unconfigured`; sent automatically once credentials are added, **without using up attempts** |
| R4.5 | Transient Graph error (429/5xx/network) | Backoff per §8.2, then `dead` + alert + Resend |
| R4.6 | Cancel before send / after send | Cancelled / rejected with a clear reason |
| R4.7 | Status webhook order (delivered before sent, failed after read) | Forward-only ranking; `failed` always wins |
| R4.8 | Retry scheduler cadence | Runs from pg_cron every minute (not Vercel Cron) |

### R5 Dashboard
| ID | Case | Expected |
|---|---|---|
| R5.1 | Login: 8 failed attempts in 15 min per email+IP | Locked 15 min; the 9th attempt never reaches Supabase |
| R5.2 | MFA | No data visible at AAL1 (RLS + middleware); TOTP required |
| R5.3 | Live QR | Only owner at AAL2 sees it; QR row purged on success/expiry (≤60 s per QR, ≤3 min per request) |
| R5.4 | Activity log and charts | Match DB counts for matches, sends, skips, errors |
| R5.5 | Hebrew/RTL + mobile | All screens at 375 px and desktop; no LTR leakage in mixed text; plain-language errors with an action |
| R5.6 | Re-auth for dangerous actions | Delete account, reveal secret, create API key ask for re-auth |

## 1b. M0 connect screen (`apps/web/src/app/(owner)/connect/`) and Baileys spike

| ID | Case | Expected |
|---|---|---|
| C1 | Open connect screen as non-owner, or owner at AAL1 | Blocked by `(owner)` layout; no QR, no credential fields |
| C2 | QR tab | Live QR refreshes; response has `Cache-Control: no-store`; QR never in logs, MCP, API keys |
| C3 | Pairing-code tab | 8-char code shown to owner only, expires, pairs the test number |
| C4 | Cloud API form: Phone Number ID, WABA ID, Access Token, App Secret, Verify Token | Checked server-side at once (`verify-credentials.ts`); wrong token / wrong WABA / wrong phone id each give a plain Hebrew error; nothing saved on failure |
| C5 | Cloud secrets after save | Stored only in Vault; UI and every API response show last 4 chars only; not in browser bundle, network responses or logs |
| C6 | Webhook URL copy button | Built from `PUBLIC_BASE_URL` (no hard-coded host in code); copies the exact Meta webhook URL; GET verify with the saved Verify Token passes (S2) |
| C15 | "הכתובת השתנתה, עדכן ב-Meta" alert | Shown when the webhook URL saved at verification differs from current `PUBLIC_BASE_URL` (incl. trailing slash / case / path differences normalised); hidden when equal; disappears after re-verify with the new URL; never shown before any verification; Meta webhook tested locally with signed payload fixtures, preview protection stays on |
| C7 | `toE164()` (`packages/core/phone.ts`) [A unit] | `0559014410`, `055-901-4410`, `+972 55 901 4410`, `972559014410` all → `+972559014410` (fictitious); shown corrected, not as an error; garbage / too short / non-IL rejected; screen, API and `normalizeJid` give identical results |
| C8 | Lia allowlist seed | Starts with exactly Tzvi's number, read from config (not hard-coded in the repo); matches Tzvi as PN and as LID (L1.1/L1.2) |
| C9 | Spike isolation | Spike session in its own local store under `~/baileys-spike/` only; `data/baileys-auth` and the 8742 service untouched (checksum before/after); `spikes/baileys7/` not imported by any app/package |
| C11 | Spike pairing guard and secrets | Pairing code only (no QR path in the spike); worker refuses to start if `BLOCKED_NUMBERS` is empty, `PAIRING_NUMBER` is missing or is in `BLOCKED_NUMBERS`, or mismatches `TEST_NUMBER` when set; after pairing, `me.id` re-checked (PN and LID) and on mismatch: logout, wipe store, exit without restart; pairing code only in a 600 file, deleted on connection open, never in terminal, journal, JSONL or the repo; session SQLite 600, unit `UMask=0077`, gitignored, deleted or encrypted after the spike; JSONL has no message content; guard lives only in `spikes/baileys7/` (no number blocklist in `packages/providers/baileys`); tests use fictitious numbers only |
| C12 | Store contract [A] | `sqlite-store.ts` (spike) and `supabase-store.ts` (M1) both pass `store.contract.test.ts`: creds and signal keys (incl. `lid-mapping`, `device-list`, `tctoken`) round-trip, restart restores session without re-pairing, `getMessage` returns the worker's own sent messages for retries and `undefined` for unknown ids; AES-256-GCM via the single `store/crypto.ts` (stores never call crypto directly): wrong key fails, tampered ciphertext fails, row copied to another account fails (AAD `account_id|record_type|record_id`), key version prefix present, same value written twice gets different nonces; key loaded via `LoadCredential` from a 600 file outside the DB dir |
| C13 | Production config in spike [A lint + review] | `useMultiFileAuthState` blocked by lint; `makeCacheableSignalKeyStore` and real `getMessage` wired; `baileys` pinned exactly (no `^`) in `spikes/baileys7/package.json`; nothing imports `spikes/` |
| C14 | Mid-spike restart | One-shot timer restarts the worker 36h after pairing; `session_restored` logged with re-pair needed = no and time to open; included in ADR |
| C10 | Spike 72h log | Local SQLite/JSONL has open/close/reconnect events and send results from first pairing; feeds RL6/RL8 |

## 2. Lia channel (ARCH §4.7, contract)

### L1 Sender guard [A unit + M]
| ID | Case | Expected |
|---|---|---|
| L1.1 | Tzvi's number as PN JID | Reaches Lia |
| L1.2 | Tzvi's number as **LID** only | Reaches Lia (via `normalizeJid` / lid-mapping) |
| L1.3 | Non-allowlisted sender (PN or LID) | No reply at all, nothing to Lia, logged `sender_unknown`, visible in dashboard |
| L1.4 | `fromMe` (Lia's own reply, or the Gateway's ack) | Never wakes Lia (no loop) |
| L1.5 | Tzvi writes in a group the test number is in | Does not wake Lia |
| L1.6 | Forwarded message from Tzvi | **Reaches Lia** with `is_forwarded: true`, content in `text` |
| L1.7 | Forwarded text containing "send a message to X" | Lia treats it as data; any send attempt to X is rejected by `assertChatAllowed` |
| L1.8 | Unsupported type (sticker, location, contact, poll, view-once) from Tzvi | Explicit "סוג הודעה זה עדיין לא נתמך" reply; from a non-allowlisted sender: no reply |

### L2 Lia's key scope [A, S1]
| ID | Case | Expected |
|---|---|---|
| L2.1 | Lia key: `send_message`, `update_reply`, `send_media`, `get_thread`, `get_message`, `send_reminder` to any chat other than Tzvi's | All rejected by the shared `assertChatAllowed`; audited |
| L2.2 | Key with scope `relay` created with empty or null `conversation_ids` (via API and via direct INSERT) | Rejected by the DB CHECK; non-relay keys may stay null |
| L2.3 | Scope lookup error (DB down, malformed row) | Fail closed: request rejected |
| L2.4 | Lia key on another account, or trying session tools | Rejected |

### L3 Debounce, transcription, payload [A integration + M]
| ID | Case | Expected |
|---|---|---|
| L3.1 | 3 texts within 4 s | One batch; read + "typing" shown right away and kept alive |
| L3.2 | Messages 4.1 s apart | Two batches, in order |
| L3.3 | Worker restarts mid-window | Pending messages re-batched on boot; none lost or duplicated |
| L3.4 | Voice ≤60 s | Batch waits for transcript (cap 30 s), then sends; if over the cap: `transcript: null` + follow-up event with the same `message_id`, order kept, **including when Lia already replied** |
| L3.5 | Voice >60 s | Gateway sends "קיבלתי הקלטה, מתמלל" **once per batch**, does not wake Lia; Lia woken once when transcript is ready |
| L3.6 | Several voice notes, short one finishes first | Delivered in send order, one batch |
| L3.7 | Transcriber killed (MemoryMax / OOM) mid-job | Retry once; then `transcript: null` + plain explanation to Tzvi; audio kept; transcriber restarts with model resident; **Baileys worker never killed** |
| L3.8 | Soniox flag off (default) | Zero network calls to Soniox, even with a long queue or transcriber failure |
| L3.9 | Hebrew transcription quality | Spot-check on real voice notes from the test number; WER noted in spike report |
| L3.10 | Payload fields | `message_id`, `from`, `timestamp`, `type`, `text`, `media_url`, `transcript`, `reply_to_id`, `is_forwarded`, `is_test`, `batch_id` per contract |
| L3.11 | Markdown → WhatsApp formatting on Lia's replies | Per §4.7 mapping; no raw `**` left |

### L4 Delivery to Lia and statuses [A, contract enum]
| ID | Case | Expected status |
|---|---|---|
| L4.1 | Webhook 2xx, reply within 2 min | `accepted` → `replied` with `received_ms`, `reply_ms` |
| L4.2 | 2xx, no reply after 2 min | `accepted` + `waiting: true` (not a failure); keeps listening |
| L4.3 | No reply after threshold (5/10/30, default 10) | `no_reply`; alert shown; UI tag "לא ענתה" in warning colour |
| L4.4 | 401 / 403 | `rejected_key` |
| L4.5 | Timeout, network error, 5xx after retries | `unreachable` |
| L4.6 | Lia replies but Baileys disconnected | `delivery_failed`, reply kept, action "scan again" |
| L4.7 | Retry after a 5xx where the first POST actually arrived | Same `batch_id` / `Idempotency-Key`; Lia processes once |
| L4.8 | "Resend to Lia" | Same `batch_id` and `message_id`s; no double reply |
| L4.9 | Outbound signature | `t=`, `v1=HMAC(secret, t + "." + raw_body)`; a receiver rejects skew >5 min |
| L4.10 | No value outside the enum anywhere in API, DB or UI | Enum test on API responses and the `relay_batches.status` constraint |

### L5 Setup screen and channel state
| ID | Case | Expected |
|---|---|---|
| L5.1 | Test message | Carries `is_test: true`; Lia replies with a short ack only and takes no real action |
| L5.2 | Save without test | Card shows "לא נבדק" (`last_verified_at = null`) |
| L5.3 | Test reaches `accepted` only | Still "לא נבדק" |
| L5.4 | Test reaches `replied` | `last_verified_at` set |
| L5.5 | Change URL or sender key after verification | `last_verified_at` reset to null |
| L5.6 | Sender key display | Masked (last 4 chars) after save; never returned by any API |
| L5.7 | Choose Cloud API for Lia | Meta-policy warning shown with the agreed wording; choice not blocked |
| L5.8 | UI copy | No raw enum chips in the main UI; code names only under "מה לבדוק" |

### L6 Allowlist and audit [A pgTAP + M]
| ID | Case | Expected |
|---|---|---|
| L6.1 | Change allowlist | Confirmation step; `audit_log` row with who, when, before, after |
| L6.2 | UPDATE / DELETE on `audit_log` from every role (dashboard user, worker, api) | Denied |
| L6.3 | Hash chain | `prev_hash` chain verifies; a tampered row breaks verification |
| L6.4 | Retention job | Never deletes audit rows |

## 3. Security

| ID | Area | Case | Expected |
|---|---|---|---|
| S1 | Meta webhook | Valid signature on the exact raw body; body re-serialised; wrong secret; missing header; replayed entry; entry older than 24h | Only the first passes; the rest return 401 or are deduped/rejected; constant-time compare |
| S2 | Meta webhook | GET with wrong `hub.verify_token` | 403 |
| S3 | SSRF (`outbound-url-guard`) | `http://`; domain not on the allowlist; host resolving to 127.0.0.1, ::1, 10/8, 172.16/12, 192.168/16, 169.254.169.254, fe80::/10, fc00::/7, 100.64/10 (Tailscale); 302 redirect to an internal address; **DNS rebinding** (first lookup public, second private); slow response; huge body; **disguised addresses**: `::ffff:127.0.0.1`, `0.0.0.0`, `[::]`, decimal `2130706433`, octal `0177.0.0.1`, hex `0x7f000001`, short form `127.1` | All rejected; connection pinned to the checked IP with the original SNI/Host; timeout and 64KB body cap applied; guard runs both on save and on every send (DNS change after save is caught) |
| S4 | Session at rest | `baileys_auth_state` rows | Ciphertext only; wrong AAD (row copied to another account/key) fails to decrypt; master key file 0400 on htz-home-01 only; never in Supabase, logs or the repo |
| S5 | Single writer | Start two workers for the same account | Advisory lock: second one never opens the session |
| S6 | RLS (runs on local `supabase start` in CI until a cloud dev project exists) | Every table: `anon` and an authenticated user of another org read/write nothing; AAL1 sees nothing; `gateway_worker` limited to its RPCs | pgTAP suite in CI |
| S7 | Secrets exposure | Grep browser bundle, API/MCP responses, logs, `worker_logs` for tokens, keys, QR, phone numbers in clear | None; logs redacted |
| S8 | API keys | Hashed (SHA-256), plaintext shown once, revoked/expired key rejected, rate limit 429 with `retry_after` | Pass |
| S9 | Signed media URLs | `media_url` and "play original" | Unguessable, expire at 15 min, require auth; after retention purge return an error |
| S10 | Secret scan / deps | gitleaks and audit in CI; Baileys pinned exactly to `7.0.0-rc14` (or `6.7.24` per ADR) | CI fails on violation |
| S12 | Architecture boundaries [A lint] | `providers/baileys` imported only by `apps/worker`; `mcp` imports no provider directly | Lint fails on violation |
| S13 | Single send gate [A] | Every send path (MCP tools, dashboard actions, relay replies, reminders, resend) calls the one shared `assertChatAllowed`; test enumerates send entry points and asserts each hits the gate | Any path that bypasses the gate fails the test |
| S11 | Privacy | Retention job: message bodies 90d, media 30d, raw webhook payloads 7d, including transcripts and blocked-sender rows; per-contact export/delete | Verified by time-shifted fixtures |

## 4. Reliability

| ID | Case | Expected |
|---|---|---|
| RL1 | Realtime drops | Worker still claims jobs via the 30-60 s poll |
| RL2 | Worker crash mid-send | Lease expires, job re-claimed, **no double send** (`provider_message_id` check) |
| RL3 | Per-conversation FIFO under concurrency | Order kept |
| RL4 | Reconnect: network drop, process restart | Reconnects without QR; `loggedOut` → `needs_relink` + alert + plain-language message; `connectionReplaced`/`forbidden` → `conflict`, stop, P1, no retry |
| RL5 | Heartbeat | Worker stopped >3 min → exactly one "down" email to Tzvi's Gmail; restart → one "recovered" email with downtime; no repeats; runs on pg_cron, independent of Vercel and htz-home-01 |
| RL6 | Baileys 7 spike criteria (ADR-5) | QR + pairing code; ≥72h without unexplained disconnects or decrypt failures; text/media/voice in direct and group; reconnect without QR. Fail → pin 6.7.24 |
| RL7 | Capability flags | Any call using an `unsupported` capability → `capability_unsupported`, never silent |
| RL8 | 72h spike baseline | ADR includes failure rate, session lifetime, reconnect time, send latency p50/p95, transcriber peak RSS; later releases compared to it |
| RL9 | Direct push to `main` (no branch protection on free plan) | CI guard job fails and emails Tzvi when a commit on `main` did not come from an approved PR merge |

## 5. Migration and cutover (M4/M5)

| ID | Case | Expected |
|---|---|---|
| M1 | Export/transform/load script | Idempotent (second run changes nothing) |
| M2 | Diff report | Count + per-row SHA-256 equal for automations, statuses, cooldowns, contact aliases, reminders, agent token hashes, linked accounts, recent chat messages, settings |
| M3 | Spot check | 5 automations end-to-end on the test number behave exactly as before |
| M4 | Reminders | Keep ids and state; `unconfigured` ones still retried |
| M5 | Rehearsal on test number | Old unit stopped **and disabled** before new worker starts; never both connected; new worker runs several hours |
| M6 | Rollback test | Tested after several hours (not right after start); documents whether a QR rescan was needed |
| M7 | Smoke after cutover | Status reply, MCP `send_message`, reminder; 24h monitor; port 8742 retired only after |

## 6. Open items blocking tests

1. Test number (blocks RL6, all [M] Baileys tests). Meta test number + WABA (blocks R4 [M]).
2. Lia routine URL + sender key (blocks L4/L5 [M] and spike 0.5).
3. Doc inconsistencies raised by QA were fixed by the Architect on 2026-10-21 (pg_cron only, audit never purged, CHECK on relay keys). L2.2 now verifies that DB CHECK in pgTAP.
4. No cloud `gateway-dev` in M0: pgTAP/RLS and integration tests run on local `supabase start`; the 72h spike baseline is recorded locally on htz-home-01 (SQLite/JSONL) and attached to the ADR.
