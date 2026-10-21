# gateway-worker

Baileys worker for the WhatsApp Gateway (ARCHITECTURE §2, §4.2, §4.4-§4.7). Runs on htz-home-01 as
a `systemd --user` unit, outbound connections only: Supabase (REST/RPC, Realtime, Storage),
WhatsApp, and the local `gateway-transcriber` unix socket.

> **Never run this worker alongside `whatsapp-automation` on the same number.** Two Baileys
> sessions on one number conflict (and can look like a ban signal). Cutover order is in
> ARCHITECTURE §9.3: stop **and disable** the old unit first.

## Modules

| Path | Responsibility |
|---|---|
| `src/main.ts` | Composition root only (wiring, signals). |
| `src/config.ts` | zod-parsed env, fail fast; refuses a `service_role` JWT. |
| `src/db/` | `WorkerDb`: one method per worker RPC / RLS select (`supabase-db.ts`), `baileys_auth_state` adapter (`auth-state-db.ts`, bytea `\x…` ↔ bytes), Realtime wake-ups (`realtime.ts`). |
| `src/session/` | `SessionManager`: per-account lease (`worker_try_lock_account`, renewed every 25 s, refused → socket closed), session events, commands, pairing (QR / pairing code). `accounts.ts`: policy/capabilities/relay allowlist per account. |
| `src/queue/` | `QueueProcessor`: `claim_jobs` → RL2 check → **send gate** → session check → pacing → send → `complete_job`/`fail_job`. Realtime INSERT wake-up + 30-60 s poll. `outbox.ts`: replies the worker originates are enqueued, never sent directly. |
| `src/inbound/` | `InboundPipeline` (status posts, contacts, sender guard, media → Storage, `ingest_inbound`, routing), `RelayChannel` (Debouncer, presence, transcription, restart recovery, `worker_create_relay_batch`), `StatusReplies` (status-reply automations). |
| `src/transcribe/` | `LocalTranscriber` (unix socket), `SonioxTranscriber` (only constructed with `SONIOX_ENABLED=true` **and** a key). |
| `src/heartbeat/` | `record_heartbeat` every 60 s; `LogShipper` (pino → stdout + batched `worker_log`, already redacted). |
| `src/shutdown.ts` | SIGTERM: stop claiming → finish in-flight job → close sockets **without logout** → release locks → flush logs. |

Send path invariant (TEST-PLAN S13): every message the worker puts on the wire goes through
`QueueProcessor`, which calls the shared `SendGate` (`@htz/policy`) with an entry point derived from
the job (`relay.reply`, `relay.system_reply`, `automations.status_reply`, `reminders.dispatch`,
`mcp.send_message`). Relay system replies and status replies are enqueued with `enqueue_message`
(idempotency-key prefixes `relay-sys:` / `status-reply:`).

## Configuration

`~/.config/gateway/worker.env`, mode **0600** (`chmod 600`), loaded by `EnvironmentFile=`. Never
commit it. Numbers below are fictitious.

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | `https://<ref>.supabase.co` (http only for localhost) |
| `SUPABASE_WORKER_JWT` | yes | HS256 JWT signed with the project JWT secret, claims `{"role":"gateway_worker","sub":"<worker_id>","exp":…}`. Rotate quarterly. **A `service_role` key is refused at start.** |
| `SUPABASE_ANON_KEY` | no | Public anon/publishable key sent as `apikey` if the API gateway requires one; the JWT is always the `Authorization` bearer. Secret keys are refused. |
| `WORKER_ID` | yes | e.g. `htz-home-01` |
| `ORG_ID` | yes | uuid of the org |
| `LIA_ALLOWLIST_SEED` | no | Comma list of numbers allowed to reach Lia, merged with `relay_targets.allowed_senders`; normalised to E.164 (`055…` → `+97255…`). Personal numbers live **only** here. |
| `TRANSCRIBER_SOCKET` | no | Default `$XDG_RUNTIME_DIR/gateway-transcriber.sock` |
| `TRANSCRIBER_TIMEOUT_MS` | no | Default 180000 |
| `SONIOX_ENABLED` / `SONIOX_API_KEY` | no | Paid, **off** by default. Soniox is used (as fallback after the local service) only when both are set. Tzvi decides. |
| `STORAGE_BUCKET` | no | Default `media` (private bucket) |
| `POLL_INTERVAL_MS` | no | 30000-60000, default 45000 |
| `LOG_LEVEL` / `LOG_SHIP_LEVEL` | no | Defaults `info` / `info` |
| `SESSION_KEY_FILE` | no | Only outside systemd; the unit uses `LoadCredential=session.key` |

```sh
# ~/.config/gateway/worker.env (example values)
SUPABASE_URL=https://example-ref.supabase.co
SUPABASE_WORKER_JWT=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiZ2F0ZXdheV93b3JrZXIi…
WORKER_ID=htz-home-01
ORG_ID=00000000-0000-4000-8000-000000000001
LIA_ALLOWLIST_SEED=+972559014410
```

Session master key: 32 random bytes at `~/.config/gateway/session.key`, mode **0400**, backed up
offline (`head -c 32 /dev/urandom > ~/.config/gateway/session.key && chmod 400 …`). Losing it means
every account must be re-paired.

## Build

```sh
pnpm -C apps/worker build      # esbuild → apps/worker/dist/main.mjs (+ sourcemap)
node --check apps/worker/dist/main.mjs
```

`@htz/*`, zod and supabase-js are bundled; `baileys` and `pino` stay external (resolved from
`apps/worker/node_modules`); `better-sqlite3` (spike-only store) is stubbed out.

## Deploy (manual, never from CI)

1. On the dev machine, at the commit to deploy: `pnpm install --frozen-lockfile && pnpm check && pnpm -C apps/worker build`.
2. On htz-home-01 (`deploy` user), keep `~/whatsapp-gateway` at the **same commit** and install
   runtime deps once per dependency change: `pnpm install --frozen-lockfile --prod --filter @htz/worker...`.
3. Copy the artifact over the tailnet:
   `rsync -av --delete apps/worker/dist/ deploy@htz-home-01:whatsapp-gateway/apps/worker/dist/`
4. First time only: `cp apps/worker/deploy/gateway-worker.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable gateway-worker`.
5. `systemctl --user restart gateway-worker && journalctl --user -u gateway-worker -f` → expect
   `worker_boot`, `worker_ready`, `session_started` per account, no `lock_*` errors.

Rollback: rsync the previous `dist/` and restart. Exit code 78 = configuration refused (fix
`worker.env` / key); systemd does not restart-loop on it.

`gateway-worker-dev.service` is the same for the `gateway-dev` project and the test number
(`~/.config/gateway/worker-dev.env`, `session-dev.key`, checkout `~/whatsapp-gateway-dev`).

## Tests

```sh
pnpm vitest run apps/worker
```

Titles start with TEST-PLAN ids (L1.x, L3.x, RL1, RL2, RL5, R2.x, S5, S13, C12). Fakes only: no
network, no sockets, fictitious numbers.

## Known gaps (need DB/server changes, not worker code)

- `relay_mark_delivery_failed` and `webhook_enqueue_event` are granted to `service_role` only. The
  worker records Lia-reply delivery failures (L4.6) as `audit_log` action `relay.delivery_failed`
  and transcript follow-ups (L3.4) as a `relay_transcript_followup` log line; the server must turn
  those into the canonical status / follow-up event.
- No Storage bucket/policy for `gateway_worker` exists in the migrations yet: media upload/download
  fails (logged as `media_store_failed`) until a private `media` bucket with worker insert/select
  policies is created.
- `BaileysSession.sendMessage` cannot take a pre-generated message id, so the optional
  `job_reserve_provider_id` step (RL2 crash window between send and `complete_job`) is not used.
