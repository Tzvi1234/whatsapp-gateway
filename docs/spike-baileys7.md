# Runbook: Baileys 7 spike (task 0.3) on htz-home-01

Goal: run `baileys@7.0.0-rc14` for ≥72h on the **test number** with the production session
config (encrypted store, `makeCacheableSignalKeyStore`, real `getMessage`, no history sync,
`markOnlineOnConnect:false`), collect the RL8 baseline and decide ADR-5 go/no-go
(TEST-PLAN C9–C14, RL4, RL6, RL8).

Code: `spikes/baileys7/` (worker, report, systemd units) on top of `@htz/provider-baileys`.
No dashboard, no Supabase. Everything stays in `~/baileys-spike/` (dir 0700, files 0600).

## Hard rules

- **Test number only.** Never pair the number used by the legacy WhatsApp-Automation unit
  (port 8742). Two Baileys sessions on one number conflict (`connectionReplaced`) and can get the
  number flagged. Do not stop, touch or reconfigure the legacy unit or its `data/baileys-auth`.
- The pairing code is written **only** to `~/baileys-spike/pairing-code.txt` (0600) and deleted as
  soon as the connection opens. Never paste it into a terminal log, chat, ticket, PR or the journal.
- Personal numbers live only in `~/.config/gateway/spike.env` (0600). Never in the repo.
- `events.jsonl` has no message content and only hashed ids. Do not add content to it.

## 1. Build

```sh
cd ~/whatsapp-gateway && git fetch && git switch spike/baileys7
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3            # only if the native module fails to load
pnpm -C spikes/baileys7 build && pnpm -C spikes/baileys7 check
```

`dist/worker.mjs` and `dist/report.mjs` keep `baileys`, `better-sqlite3` and `pino` external;
they resolve from `spikes/baileys7/node_modules`, so run them from that directory (the unit does).

## 2. Session master key (32 bytes, 0400, outside the data dir)

```sh
mkdir -p ~/.config/gateway && chmod 700 ~/.config/gateway
( umask 077; head -c 32 /dev/urandom > ~/.config/gateway/spike-session.key )
chmod 0400 ~/.config/gateway/spike-session.key
```

The unit passes it with `LoadCredential=session.key:%h/.config/gateway/spike-session.key`; the worker
reads `$CREDENTIALS_DIRECTORY/session.key` and refuses files looser than 0600/0400 or not exactly
32 bytes (exit 78). Losing the key only means re-pairing; no offline backup needed for the spike.

## 3. Config (`~/.config/gateway/spike.env`, 0600)

```sh
( umask 077; cat > ~/.config/gateway/spike.env ) <<'EOF'
PAIRING_NUMBER=<test number, e.g. 05X-XXX-XXXX>
TEST_NUMBER=<same test number>
BLOCKED_NUMBERS=<Tzvi's personal number>,<legacy automation number>
PROBE_INTERVAL_MIN=15
EOF
```

Guard (C11): the worker refuses to start (exit 42, no restart) if `BLOCKED_NUMBERS` is empty,
`PAIRING_NUMBER` is missing or blocked, or differs from `TEST_NUMBER`. All values go through
`toE164`. After pairing it re-checks `me.id` (PN and LID); on mismatch it logs out, wipes the store
and exits 42. `PROBE_INTERVAL_MIN` (0 = off, else ≥5) sends a short note-to-self text (only to the
account's own JID) to measure send latency.

## 4. C9 baseline of the legacy session (before)

```sh
find <legacy-checkout>/data/baileys-auth -type f -print0 | sort -z | xargs -0 sha256sum \
  > ~/baileys-spike-c9-before.txt
systemctl --user status <legacy-unit> --no-pager | head -3   # note state, do not change it
```

## 5. Install and start

```sh
cp ~/whatsapp-gateway/spikes/baileys7/deploy/baileys-spike.service \
   ~/whatsapp-gateway/spikes/baileys7/deploy/baileys-spike-restart.{service,timer} \
   ~/.config/systemd/user/
systemctl --user daemon-reload
loginctl enable-linger "$USER"        # once, so user units survive logout
systemctl --user start baileys-spike.service
journalctl --user -u baileys-spike -f  # redacted; never contains the code
```

If the unit fails with a credentials error (older systemd without `LoadCredential=` for user
units), comment out `LoadCredential=` and add `SESSION_KEY_FILE=%h/.config/gateway/spike-session.key`
to the unit (`Environment=`). If it fails with status 218/226 (no unprivileged user namespaces),
comment out `PrivateTmp=` and `NoNewPrivileges=`. Note any such change in the ADR.

## 6. Pairing (pairing code only; no QR path in the spike)

1. The worker writes the 8-character code to `~/baileys-spike/pairing-code.txt` and logs only
   `pairing_code_issued`.
2. Coder reads it in a private SSH session: `cat ~/baileys-spike/pairing-code.txt` — never copy it
   into tmux logs, chat transcripts, tickets or this repo.
3. Coder relays it to Tzvi privately (phone call, or a direct message deleted right after use).
4. On the **test phone**: WhatsApp → Linked devices → Link a device → *Link with phone number
   instead* → enter the code. The code is short-lived; if it expires the worker requests a new one
   (up to 3 sockets) and then exits 43 — just `systemctl --user restart baileys-spike`.
5. On `open` the file is deleted and `paired` + `open` are logged. Check:
   `test ! -e ~/baileys-spike/pairing-code.txt && tail -n 5 ~/baileys-spike/events.jsonl`.
6. Start the one-shot 36h restart (C14): `systemctl --user start baileys-spike-restart.timer`.

## 7. During the 72h

Manual RL6 checks from a second test phone (note results with timestamps for the ADR):
text, image, video, document, voice note in a direct chat and in a test group (both directions);
a network drop (`nmcli networking off; sleep 60; nmcli networking on`) must reconnect without
re-pairing; the 36h timer restart must log `session_restored` with `re_pair_needed:false`.

```sh
tail -f ~/baileys-spike/events.jsonl | jq -c 'select(.type!="heartbeat")'
systemctl --user list-timers baileys-spike-restart.timer
```

| Exit | Meaning | Action |
|---|---|---|
| 41 | logged out (401) — store wiped | Record in ADR; re-pair only if continuing |
| 42 | number guard (config or paired identity mismatch) | Fix `spike.env`; never bypass |
| 43 | pairing code not used in time | `systemctl --user restart baileys-spike` |
| 44 | conflict (440 replaced / 403 forbidden) | Stop. Check no other client uses the number. P1 note in ADR |
| 50 | bad session (500/411) — store wiped | Record in ADR |
| 78 | config / key file unsafe | Fix key mode/size or env |

## 8. Report (RL8 → ADR-5)

```sh
pnpm -C ~/whatsapp-gateway/spikes/baileys7 report                  # markdown
pnpm -C ~/whatsapp-gateway/spikes/baileys7 report -- --json        # raw numbers
node dist/report.mjs /path/to/events.jsonl                         # other file
```

Paste the markdown into "Spike results" of `docs/adr/0005-baileys-version.md`, plus the manual RL6
results and the transcriber peak RSS (measured separately). It covers uptime %, session lifetime,
disconnects by code, reconnect time p50/p95, send latency p50/p95, decrypt failures, failure rate
and whether a re-pair was needed after the 36h restart.

## 9. Teardown and wipe (after the spike)

```sh
systemctl --user stop baileys-spike-restart.timer baileys-spike.service
systemctl --user disable baileys-spike.service 2>/dev/null || true
rm ~/.config/systemd/user/baileys-spike*.{service,timer} && systemctl --user daemon-reload
```

1. On the test phone: Linked devices → select the spike device → Log out.
2. Keep a copy of the report output (not the raw JSONL) for the ADR, then wipe:
   `shred -u ~/baileys-spike/auth/session.sqlite* ~/.config/gateway/spike-session.key ~/.config/gateway/spike.env; rm -rf ~/baileys-spike`
3. C9 after-check: rerun the checksum command from step 4 into `~/baileys-spike-c9-after.txt` and
   `diff` it with the before file — it must be identical; the legacy unit must be in the same state.
