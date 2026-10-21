# WhatsApp Gateway: Database (Supabase)

Owner: Developer · Implements ARCHITECTURE.md §4-§8 (PLAN task 1.1, plus 1.7/1.8 scheduling and 3.5 retention).
Layout: `supabase/migrations/*.sql` (applied in name order), `supabase/tests/*.sql` (pgTAP),
`supabase/functions/*` (Deno Edge Functions), `supabase/seed.sql`, `supabase/config.toml`.
Region: EU Frankfurt (deploy concern only).

## 1. Conventions

- `uuid` PKs, `timestamptz` (UTC), `org_id` on every row (single org now, multi-tenant ready).
- Enums are `text` + `CHECK` (easy to evolve). Values match `packages/core` exactly:
  `ProviderKind`, `ConnectionState`, `MessageStatus`, `UseCase`, `Scope`, `LiaTestStatus`.
- RLS enabled on **every** table. Writes go through `security definer` RPCs with
  `set search_path = ''` and fully-qualified names. EXECUTE grants are all in
  `20261021141200_function_grants.sql`.
- Secrets live only in Supabase Vault; tables keep Vault ids + last 4 characters.

## 2. Tables

| Table | Purpose / notable constraints |
|---|---|
| `orgs`, `org_members` | Tenancy; `role` owner/admin/viewer |
| `accounts` | `provider` baileys/meta_cloud, `status` (ConnectionState), `capabilities`, `use_case_policy`, `pacing`, `alias` (legacy `default`/`meta-default`); unique `(org_id, phone_e164, provider)` |
| `provider_credentials` | Meta ids, Vault ids for token/app secret/verify token, `*_last4`, `verified_webhook_url` + `webhook_verified_at` (C15 banner) |
| `baileys_auth_state` | Ciphertext only, PK `(account_id, key_type, key_id)`; worker-only |
| `sessions` | 1 row/account; `connection`, heartbeat, single-writer lease `worker_id` + `lock_until` |
| `session_events` | open/close/qr/paired/relinked/conflict/needs_relink/logged_out/restored; idx `(account_id, at desc)` |
| `pairing_requests`, `pairing_qr` | Request ≤3 min; QR row ≤60 s (CHECK); owner + AAL2 only; purged every minute |
| `contacts` | unique `(account_id, coalesce(lid, pn_jid))` |
| `conversations` | unique `(account_id, chat_jid)`; `last_inbound_at` (24h window); idx `(account_id, last_message_at desc)` |
| `messages` | unique `(account_id, provider_message_id)`, unique `(api_client_id, idempotency_key)`, idx `(conversation_id, created_at desc)`, partial idx `status in (queued, failed)`; `relay_state` pending/batched/skipped |
| `outbound_queue` | `executor` worker/edge, `state` ready/leased/done/dead, lease, `seq` (FIFO); partial idx `(executor, run_at) where state='ready'`; `max_attempts` 6 = 1 + 5 retries |
| `session_commands` | reconnect/logout/pair/mark_read, consumed by the worker; `payload` jsonb (mark_read: `{chat, ids[1..100]}`, CHECK) |
| `inbound_events` | unique `dedupe_key`; `raw` purged after 7 days |
| `automations`, `automation_cooldowns`, `statuses`, `reply_jobs` | Status-reply automations; cooldown unique `(account_id, provider_status_id, contact_key)` = one reply per contact per status |
| `reminders` | `state` incl. `unconfigured`; idx `(state, due_at)`; unique `(api_client_id, client_reminder_id)` (MCP `client_msg_id`); `message_id` + trigger: state follows the message status; dispatch lease `lease_owner`/`lease_until`; `error_code`/`error_detail` (gate reason, R4.2) |
| `relay_targets` | `url` (https), Vault secret + last4, `debounce_ms` 3000-5000 (default 4000), `no_reply_threshold_min` in (5,10,30) default 10, `allowed_senders` (E.164 CHECK), `last_verified_at` (null = "untested"), `last_test` (status CHECK) |
| `relay_batches` | `batch_id` unique (Idempotency-Key), `message_ids uuid[]`, `status` CHECK = exactly the 6 canonical values (null = not delivered yet), `is_test`, `attempts`, `accepted_at`, `first_response_at`, `replied_at`, `reply_message_id` (Lia's reply, set by `relay_mark_replied`) |
| `relay_followups` | Transcript follow-up events (L3.4) to the relay target: unique `(batch_id, message_id, event)`, `transcript` (null = failed), `status` pending/delivered/failed/dead, retries like webhooks; delivered only after the batch itself; finished rows purged after 7 days |
| `webhook_endpoints`, `webhook_deliveries` | Generic signed webhooks; retries 10s,30s,2m,10m,30m,2h then dead |
| `api_clients` | `key_prefix` unique, `key_hash` (sha256 hex CHECK), `scopes` ⊆ Scope, `account_ids`, `conversation_ids` (CHECK: `relay` ⇒ non-null and non-empty), `rate_limit`, `expires_at`, `revoked_at`, `last_used_at`, `legacy` |
| `audit_log` | Append-only, hash-chained (`seq`, `prev_hash`, `hash`) |
| `alerts` | severity P1-P3, kind, open/ack/resolved |
| `worker_heartbeats`, `worker_logs` | 7-day retention |
| `heartbeat_state`, `downtime_intervals` | Server-down state machine + outage log (doubles as the e-mail outbox) |
| `login_attempts`, `rate_limit_buckets` | Lockout and token buckets (`org_id` nullable: pre-auth / global) |
| `media_purge_queue` | Storage objects whose references retention removed (delete via Storage API) |

## 3. Security model

| Role | Access |
|---|---|
| `anon` | Nothing: no table grants, no EXECUTE on any public function. |
| `authenticated` (dashboard) | `SELECT` only, rows of orgs where `is_member(org_id)`, which requires `auth.jwt()->>'aal' = 'aal2'`. `pairing_requests`, `pairing_qr`, `provider_credentials`, `api_clients` need `is_owner(org_id)`. `api_clients.key_hash` is excluded by column grant (select explicit columns). No INSERT/UPDATE/DELETE anywhere. EXECUTE only on `is_member`, `is_owner`, `realtime_topic_allowed`. |
| `gateway_worker` (NOLOGIN, custom JWT `role` claim) | Worker RPCs (below); direct read/write on `baileys_auth_state`, `sessions`, `messages`; read-only on `accounts`, `conversations`, `contacts`, `outbound_queue`, `session_commands`, `pairing_requests`, `relay_targets`, `relay_batches`, `automations`, `statuses`, `automation_cooldowns` (needed for Realtime). Nothing else. Granted to `authenticator` so PostgREST can switch to it. |
| `service_role` (Vercel server, Edge Functions) | Server RPCs; normal DML on tables (BYPASSRLS), except `audit_log` (SELECT only) and `baileys_auth_state` (none). |
| table owner / others | `audit_log` UPDATE/DELETE/TRUNCATE blocked by trigger for every non-superuser role, even with privileges. |

Allowlist single source (L6.1, L2.1): the send gate reads `accounts.use_case_policy.sender_allowlist`,
which triggers keep derived from the enabled relay targets' `allowed_senders` (union, sorted): any
target change (`allowed_senders`, `enabled`, insert/delete) re-derives it, and a direct write to
`use_case_policy` cannot store a different list. An enabled target also sets `relay: true` and adds
`agent_relay` to `allowed_use_cases`. The worker still merges `LIA_ALLOWLIST_SEED` (config) on top.

`audit_log`: a BEFORE INSERT trigger takes an advisory xact lock, assigns `seq`, sets
`prev_hash` = previous row's `hash` (genesis = 64 zeros) and `hash = sha256(jsonb_build_array(prev_hash,
seq, org_id, actor_type, actor_id, action, target, host(ip), meta, at_utc)::text)`. `audit_verify_chain()`
returns `(ok, checked, first_bad_seq)`. Retention never touches it.

Worker JWT: sign an HS256 JWT with the project JWT secret, claims `{"role": "gateway_worker", "sub": "<worker_id>", "exp": ...}`; rotate quarterly (ARCH §7.2). Single-org today: worker policies are not org-scoped.

## 4. RPC catalogue

Caller: **W** = `gateway_worker`, **S** = `service_role`, **U** = `authenticated`. All `public.`.

### Queue and messages
| Function | Returns | Caller | Notes |
|---|---|---|---|
| `enqueue_message(p_account_id uuid, p_chat_jid text, p_kind text, p_body text=null, p_media_path text=null, p_media_mime text=null, p_template jsonb=null, p_quoted_provider_id text=null, p_use_case text=null, p_api_client_id uuid=null, p_idempotency_key text=null, p_created_by uuid=null, p_executor text='auto', p_requested_at timestamptz=null, p_prior_attempts int=0, p_delivery_mode text=null)` | `table(message_id, status, created, job_id, conversation_id, provider_message_id)` | W, S | ON CONFLICT `(api_client_id, idempotency_key)` returns the existing row (`created=false`), safe under concurrency. `auto`: baileys → worker job; meta_cloud → no job (Vercel sends directly). `worker`/`edge`/`none` explicit; executor must match provider. Policy checks (assertChatAllowed, 24h window) happen in app code before this. |
| `message_record_send_result(p_message_id uuid, p_provider_message_id text=null, p_error_code text=null, p_transient bool=false, p_delivery_mode text=null)` | `text` sent/queued/failed | S | Result of a direct Cloud send. Transient → `edge` job, attempt 1, retry in 5 s. |
| `message_requeue(p_message_id uuid)` | `uuid` job | S | Resend of a failed/cancelled message that was never confirmed sent (`sent_at` null; a Baileys reserved id is kept and reused). |
| `claim_jobs(p_worker_id text, p_executor text, p_n int=10)` | `table(job_id, message_id, account_id, conversation_id, chat_jid, attempts, lease_until, kind, body, media_path, media_mime, template, quoted_provider_id, provider_message_id, idempotency_key, use_case, delivery_mode)` | W, S | Reclaims expired leases first (exhausted → dead + alert), then `FOR UPDATE SKIP LOCKED`, 60 s lease, only the oldest unfinished job per conversation. Messages → `sending`. **If `provider_message_id` is set:** `edge` jobs → `complete_job` (Cloud ids are only stored on success); `worker` jobs → it is a reserved id: complete if the device's sent-message store has it, else resend with the SAME id (never a new one). |
| `renew_lease(p_job_id uuid, p_worker_id text)` | `timestamptz` or null (lease lost) | W, S | |
| `job_reserve_provider_id(p_job_id uuid, p_worker_id text, p_provider_message_id text)` | `bool` | W | Pre-send step used by the worker for every Baileys send (`generateMessageIDV2`, sent with `messageId`) so a crash between send and commit never causes a double send (RL2). false = lease lost / id already set → do not send. |
| `complete_job(p_job_id uuid, p_provider_message_id text, p_delivery_mode text=null)` | `bool` (true only for the call that completed) | W, S | Idempotent; message → `sent` only while it has no provider id (or the same reserved id). |
| `fail_job(p_job_id uuid, p_error_code text, p_transient bool, p_detail text=null)` | `text` ready/dead/done | W, S | Permanent → dead + message failed. Transient → retry after 5s, 30s, 2m, 10m, 15m; 6th failure (1 + 5 retries) → dead + P2 `dead_letter` alert. |
| `ingest_inbound(p_account_id uuid, p_provider_message_id text, p_chat_jid text, p_kind text, p_body text=null, p_sender_jid text=null, p_from_me bool=false, p_push_name text=null, p_received_at timestamptz=null, p_is_forwarded bool=false, p_quoted_provider_id text=null, p_media_path text=null, p_media_mime text=null, p_media_seconds numeric=null, p_relay_state text=null, p_raw jsonb=null, p_source text=null, p_chat_type text=null)` | `table(message_id, conversation_id, created)` | W, S | Idempotent on `(account_id, provider_message_id)`; dedupes `inbound_events`; updates `last_inbound_at`/`last_message_at`; fans out `message.received`. |
| `apply_message_status(p_account_id uuid, p_provider_message_id text, p_status text, p_at timestamptz=null, p_error_code text=null)` | `bool` applied | W, S | Forward-only `sent<delivered<read`; `failed` always wins; failed/cancelled terminal. Fans out `message.status`. |
| `message_set_transcript(p_message_id uuid, p_transcript text)` | `bool` | W | Sets `transcript_ready_at` (transcript latency metric). |
| `webhook_enqueue_event(p_org_id uuid, p_account_id uuid, p_event text, p_payload jsonb)` | `int` | S | Generic webhook fan-out. |

### Worker
| Function | Returns | Caller | Notes |
|---|---|---|---|
| `record_heartbeat(p_org_id uuid, p_worker_id text, p_version text=null, p_baileys_version text=null, p_sockets jsonb='[]')` | void | W | Every 60 s. `p_sockets`: `[{"account_id": "...", ...}]`. Closes an open outage (recovery). |
| `worker_try_lock_account(p_account_id uuid, p_worker_id text, p_ttl_seconds int=90)` | `bool` | W | Single writer (ADR-4, S5). Lease on `sessions` taken under `pg_try_advisory_xact_lock` (a session-level advisory lock does not survive PostgREST's pooled one-transaction-per-call model). Call again every ≤30 s to renew; on `false` close the socket. |
| `worker_unlock_account(p_account_id uuid, p_worker_id text)` | `bool` | W | |
| `worker_session_event(p_account_id uuid, p_worker_id text, p_event text, p_code text=null)` | `uuid` | W | Updates `sessions.connection` + `accounts.status`; P1 alert on `conflict`/`needs_relink`/`logged_out`, resolved on open; `session.changed` webhook. Raises 55P03 if another worker holds the lock. |
| `worker_complete_session_command(p_command_id uuid, p_state text, p_result text=null)` | `bool` | W | |
| `worker_pairing_qr_upsert(p_request_id uuid, p_worker_id text, p_qr text=null, p_pairing_code text=null, p_ttl_seconds int=60)` | `uuid` | W | TTL capped at 60 s and at the request expiry. |
| `worker_pairing_finish(p_request_id uuid, p_worker_id text, p_state text, p_phone_e164 text=null)` | `bool` | W | paired/expired/failed; deletes QR, sets phone, `paired` event, audit. |
| `worker_upsert_contact(p_account_id uuid, p_pn_jid text=null, p_lid text=null, p_display_name text=null)` | `uuid` | W | Merges PN/LID identities. |
| `worker_upsert_status(p_account_id uuid, p_provider_status_id text, p_kind text=null, p_caption text=null, p_media_path text=null, p_posted_at timestamptz=null, p_expires_at timestamptz=null)` | `uuid` | W | Binds `next_status` automations to the first new status. |
| `worker_take_cooldown(p_account_id uuid, p_provider_status_id text, p_contact_key text, p_automation_id uuid=null, p_status_id uuid=null)` | `bool` (true = first) | W | One reply per contact per status. |
| `worker_record_reply_job(p_account_id uuid, p_outcome text, p_automation_id uuid=null, p_status_id uuid=null, p_inbound_message_id uuid=null, p_outbound_message_id uuid=null, p_contact_key text=null, p_detail text=null)` | `uuid` | W | Outcomes: queued/sent/failed/skipped_*. |
| `worker_create_relay_batch(p_relay_target_id uuid, p_message_ids uuid[], p_conversation_id uuid=null, p_is_test bool=false, p_batch_id uuid=null)` | `uuid` batch_id | W | Idempotent on `batch_id`; marks messages `relay_state='batched'`; kicks `deliver-webhooks`. |
| `worker_relay_delivery_failed(p_message_id uuid)` | `bool` | W | L4.6: the (failed, outbound, Baileys) message is the linked reply of a batch → batch `delivery_failed`; audited `relay.delivery_failed`. 55000 if the message did not fail. |
| `worker_relay_transcript_followup(p_batch_id uuid, p_message_id uuid, p_transcript text=null)` | `uuid` followup id | W | L3.4: idempotent per (batch, message); the message must be in the batch. Kicks `deliver-webhooks`. |
| `worker_log(p_org_id uuid, p_worker_id text, p_entries jsonb)` | `int` | W | `[{level,msg,correlation_id,data,at}]`, already redacted. |
| `audit_append(p_org_id uuid, p_actor_type text, p_actor_id text, p_action text, p_target text=null, p_ip inet=null, p_meta jsonb='{}')` | `uuid` | W, S | The only write path into `audit_log`. |

### Reminders (R4.1-R4.6)
| Function | Returns | Caller | Notes |
|---|---|---|---|
| `reminder_create(p_account_id uuid, p_to_e164 text, p_due_at timestamptz, p_body text=null, p_template_name text=null, p_template_language text=null, p_template_params jsonb='[]', p_api_client_id uuid=null, p_client_reminder_id text=null, p_created_by uuid=null)` | `table(reminder_id, created)` | S | Idempotent on `(api_client_id, client_reminder_id)` (`created=false` → MCP `duplicate: true`). Cloud account without credentials → `unconfigured`. |
| `reminders_dispatch_due()` | `int` due | S, cron | Every minute: due reminders of unconfigured Cloud accounts → `unconfigured` (attempts untouched, R4.4); `unconfigured` with credentials → `scheduled`; anything due → `invoke_edge_function('reminders-dispatch')`. |
| `reminders_claim_due(p_worker_id text, p_n int=20)` | `table(reminder_id, account_id, attempts, lease_until)` | S | `FOR UPDATE SKIP LOCKED`; due `scheduled` (or `sending` with no message and an expired lease) → `sending`, 60 s lease. |
| `reminder_record_dispatch(p_reminder_id uuid, p_message_id uuid=null, p_error_code text=null, p_detail text=null, p_unconfigured bool=false)` | `text` state | S | Only while `sending` without a message (else idempotent no-op). Message → linked, attempt +1, state = message status; error → `failed` + reason, attempt +1; unconfigured → no attempt. |
| `reminder_cancel(p_reminder_id uuid, p_account_id uuid)` | `text` | S | R4.6: only `scheduled`/`unconfigured`; otherwise 55000 `reminder_already_<state>`. |

The send itself is never done in SQL: Vercel `POST /api/internal/reminders` `{reminder_id, lease_until}`
runs the send gate (`reminders.dispatch`; text inside the 24h window, approved template outside, else
`outside_24h_window`), then `enqueue_message` with idempotency key `reminder:<id>` (Cloud: Graph send +
`message_record_send_result`; Baileys: worker job, gated again by the worker).

### Server (Vercel / Edge Functions)
| Function | Returns | Caller | Notes |
|---|---|---|---|
| `create_api_client(p_org_id uuid, p_name text, p_key_prefix text, p_key_hash text, p_scopes text[], p_account_ids uuid[]='{}', p_conversation_ids uuid[]=null, p_rate_limit jsonb=null, p_expires_at timestamptz=null, p_legacy bool=false, p_actor_user_id uuid=null, p_ip inet=null)` | `uuid` | S | Caller generates `gw_<prefix>_<secret>`, shows it once, passes `sha256(secret)` hex only. Audited. |
| `revoke_api_client(p_id uuid, p_actor_user_id uuid=null, p_ip inet=null)` | `bool` | S | Audited. |
| `lookup_api_client(p_key_prefix text)` | `table(id, org_id, name, key_hash, scopes, account_ids, conversation_ids, rate_limit, expires_at, legacy)` | S | Active keys only (revoked/expired → no row → fail closed). Compare with `timingSafeEqual`, then `api_client_touch(id)`. |
| `lookup_legacy_api_client(p_key_hash text)` | same columns | S | Imported legacy WA-Automation tokens (`legacy=true`, `key_prefix` null): lookup by lowercase SHA-256 hex of the whole token (R3.3). |
| `api_client_touch(p_id uuid)` | void | S | `last_used_at`, at most once a minute. |
| `rate_limit_take(p_key text, p_capacity int, p_refill_per_sec double precision, p_cost int=1)` | `table(allowed, retry_after_ms, remaining)` | S | Token bucket; e.g. key `apikey:<id>:req`, capacity 60, refill 1/s. |
| `login_check_lockout(p_email text, p_ip inet)` | `table(locked, retry_after_seconds)` | S | Call before Supabase Auth; 8 failures within 15 min per email+IP → locked 15 min. |
| `login_record_attempt(p_email text, p_ip inet, p_success bool)` | void | S | |
| `vault_store_secret(p_name text, p_secret text)` | `uuid` | S | Creates or updates by name. |
| `vault_read_secret(p_id uuid)` | `text` | S | |
| `provider_credentials_upsert(p_account_id uuid, p_phone_number_id text=null, p_waba_id text=null, p_access_token text=null, p_app_secret text=null, p_verify_token text=null, p_verified_webhook_url text=null, p_actor_user_id uuid=null, p_ip inet=null)` | `uuid` | S | Secrets → Vault (rotated in place), last 4 stored, null = keep. Audited without secrets. |
| `provider_credentials_read(p_account_id uuid)` | `table(phone_number_id, waba_id, access_token, app_secret, verify_token)` | S | For the Graph call / webhook verify only. Never return to clients. |
| `provider_credentials_mark_webhook_verified(p_account_id uuid, p_url text)` | `bool` | S | C15 banner baseline. |
| `request_session_command(p_account_id uuid, p_command text, p_requested_by uuid=null, p_via text='dashboard', p_ip inet=null)` | `uuid` | S | Dashboard Reconnect / MCP `session_reconnect`. Audited. |
| `request_mark_read(p_account_id uuid, p_chat text, p_ids text[], p_via text='mcp')` | `uuid` | S | MCP `mark_read` on a Baileys account → `session_commands` `mark_read` (worker sends the read receipts). Cloud accounts use the Graph read receipt instead. |
| `create_pairing_request(p_account_id uuid, p_requested_by uuid, p_method text='qr', p_phone_e164 text=null, p_ip inet=null)` | `uuid` | S | Cancels older requests + QR rows. Audited. |
| `relay_set_target(p_account_id uuid, p_name text, p_url text, p_secret text=null, p_debounce_ms int=null, p_no_reply_threshold_min int=null, p_enabled bool=null, p_actor_user_id uuid=null, p_ip inet=null)` | `uuid` | S | Upsert by `(account_id, name)`. Secret → Vault. A changed URL or key resets `last_verified_at` to null (L5.5). Run the outbound URL guard before calling. Audited before/after (masked). |
| `relay_allowlist_update(p_relay_target_id uuid, p_allowed_senders text[], p_actor_user_id uuid, p_confirmed bool, p_ip inet=null)` | `text[]` | S | Requires `p_confirmed=true`; E.164 only; audit row with before/after (L6.1). The **only** way to change `relay_targets.allowed_senders` (a trigger rejects direct writes with 42501, even for service_role). |
| `relay_record_test(p_relay_target_id uuid, p_result jsonb)` | `bool` | S | Stores `LiaTestResult`; `replied` sets `last_verified_at`. |
| `relay_mark_replied(p_batch_id uuid, p_at timestamptz=null, p_message_id uuid=null)` | `bool` | S | Agent replied (send with `reply_to_id`). Test batch → channel verified. `p_message_id` links the reply (L4.6). |
| `relay_mark_delivery_failed(p_batch_id uuid)` | `bool` | S | |
| `relay_resend_batch(p_batch_id uuid)` | `bool` | S | Same `batch_id` / `message_ids`. |
| `claim_deliveries(p_worker_id text, p_n int=20)` | `table(kind 'webhook'\|'relay'\|'relay_followup', id, attempt)` | S | `id` = delivery id, `batch_id` or follow-up id; 60 s lease. Follow-ups only once their batch has a status. |
| `relay_followup_delivery_result(p_id uuid, p_http_status int, p_error text=null)` | `text` delivered/failed/dead | S | 2xx delivered; 0/408/429/5xx retried (webhook backoff); other 4xx or 6th attempt → dead. |
| `relay_followups_purge(p_days int=7)` | `int` | S, cron | Deletes delivered/dead follow-ups (they carry transcripts, S11). |
| `relay_batch_delivery_result(p_batch_id uuid, p_http_status int, p_error text=null)` | `text` | S | 2xx accepted; 401/403 rejected_key; 0/408/429/5xx retried then unreachable; other 4xx unreachable. Use 0 for network/timeout. |
| `webhook_delivery_result(p_id uuid, p_response_code int, p_error text=null)` | `text` | S | delivered / failed (retry) / dead + alert. |
| `relay_evaluate_no_reply()` | `int` | S, cron | accepted past threshold → `no_reply` + alert. |
| `heartbeat_evaluate(p_stale interval='3 minutes')`, `heartbeat_claim_notifications(p_lease_seconds int=120)`, `heartbeat_ack_notification(p_interval_id uuid, p_kind text)` | | S | Used by `heartbeat-alert`. |
| `audit_verify_chain()` | `table(ok, checked, first_bad_seq)` | S | |
| `retention_run(p_body_days=90, p_media_days=30, p_raw_days=7, p_log_days=7)`, `pairing_purge_expired()` | `jsonb` / `int` | S, cron | |

### Dashboard (RLS helpers)
`is_member(org_id) → bool`, `is_owner(org_id) → bool`, `realtime_topic_allowed(topic) → bool` (U).

## 5. Realtime

- Publication `supabase_realtime` (postgres_changes, RLS-checked per subscriber): `outbound_queue`,
  `session_commands`, `pairing_requests` (worker), `sessions`, `pairing_qr` (dashboard).
- Private broadcast topics (RLS on `realtime.messages`), sent by triggers via `realtime.send`:
  `org:<org_id>:sessions` (members, `sessions` changes), `org:<org_id>:alerts` (members),
  `org:<org_id>:pairing` (owner + AAL2; QR insert/update/delete). Subscribe with `{ config: { private: true } }`.

## 6. Scheduled jobs (pg_cron → pg_net → Edge Functions)

| Job | Schedule | Command |
|---|---|---|
| `gw-heartbeat-check` | every minute | `invoke_edge_function('heartbeat-alert')` |
| `gw-cloud-retry` | every minute | `invoke_edge_function('cloud-retry')` when `edge_jobs_due()` |
| `gw-deliver-webhooks` | every minute | `invoke_edge_function('deliver-webhooks')` when `deliveries_due()` (also kicked on insert) |
| `gw-relay-no-reply` | every minute | `relay_evaluate_no_reply()` (SQL only) |
| `gw-reminders` | every minute | `reminders_dispatch_due()` → `invoke_edge_function('reminders-dispatch')` when reminders are due |
| `gw-pairing-purge` | every minute | `pairing_purge_expired()` (SQL only) |
| `gw-retention` | daily 02:17 UTC | `retention_run()` (SQL only) |
| `gw-relay-followups-purge` | daily 02:23 UTC | `relay_followups_purge()` (SQL only) |

One-time Vault setup per project (SQL editor):
```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'edge_base_url');
select vault.create_secret('<random 32+ bytes>', 'edge_cron_secret');
```

Edge Function env (`supabase secrets set ...`; `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are injected):

| Function | Env |
|---|---|
| all | `EDGE_CRON_SECRET` (= Vault `edge_cron_secret`) |
| `heartbeat-alert` | `ALERT_EMAIL_API_KEY`, `ALERT_EMAIL_TO` (comma-separated; Tzvi's Gmail, never in the repo), `ALERT_EMAIL_FROM`, optional `ALERT_EMAIL_API_URL` (Resend-compatible, default `https://api.resend.com/emails`). Missing → dry-run (logs only). |
| `cloud-retry`, `deliver-webhooks`, `reminders-dispatch` | `PUBLIC_BASE_URL`, `INTERNAL_API_SECRET` → `POST /api/internal/cloud-send` `{job_id, message_id, account_id, attempt, lease_until}` `POST /api/internal/reminders` `{reminder_id, lease_until}` and `POST /api/internal/deliver` `{kind: 'relay'\|'webhook'\|'relay_followup', id, attempt}` with header `x-internal-secret`. Vercel re-runs the send gate on every Cloud retry (S13: policy, key binding and 24h window may have changed; a rejection is `fail_job` permanent with the gate's code), performs the Graph call / HMAC-signed POST and records the result with `complete_job`/`fail_job` and `relay_batch_delivery_result`/`webhook_delivery_result`. |

## 7. Retention (S11, L6.4)

Message bodies + transcripts 90 days, media paths 30 days (files queued in `media_purge_queue` for
deletion through the Storage API; a direct `DELETE` on `storage.objects` would orphan them),
`inbound_events.raw` and delivered webhook payloads 7 days, `worker_logs`/`worker_heartbeats` 7 days,
`login_attempts` 30 days, idle rate buckets 1 day, expired pairing rows. **`audit_log` is never touched.**

## 8. Metrics views (`security_invoker = true`)

`v_transcript_latency` (by audio-length bucket, p50/p90 s), `v_failed_rate_by_provider` (24h/7d),
`v_session_lifetime`, `v_reconnect_time`, `v_send_latency` (p50/p95 ms per day/provider),
`v_relay_first_response` (p50/p95 ms), `v_relay_no_reply_rate`, `v_first_connect_funnel`.

## 9. Running the tests

```bash
supabase start          # local stack (Docker)
supabase test db        # runs supabase/tests/*.sql with pg_prove (00_helpers.sql first)
deno test supabase/functions/_shared/heartbeat.test.ts
```
`00_helpers.sql` commits helper functions into schema `tests`; every other file runs in a
transaction that is rolled back. Test titles start with TEST-PLAN ids (S6, L2.2, L4.10, L6.x, RL2,
RL3, RL5, R4.5, R4.7, R4.8, R5.1, R5.3, S5, S8, S11, C5, ...).

Without Docker: any PostgreSQL 15+ with `pgcrypto`, `pgtap` (and optionally `pg_cron`) plus a small
shim for the Supabase objects the migrations use (roles `anon`/`authenticated`/`service_role`/`authenticator`,
`auth.uid()`/`auth.jwt()` reading `request.jwt.claims`, `vault.create_secret`/`update_secret`/`decrypted_secrets`,
`net.http_post`, `realtime.messages`/`realtime.topic()`/`realtime.send`, publication `supabase_realtime`).
