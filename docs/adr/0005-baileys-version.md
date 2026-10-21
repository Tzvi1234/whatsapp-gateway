# ADR-5: Baileys version

Status: provisional (pending M0 spike, task 0.3) · Date: 2026-10-21

BAILEYS_VERSION: `7.0.0-rc14`

## Decision
Start on Baileys 7.x with an exact pin (`"baileys": "7.0.0-rc14"`, npm `latest`). The CI step
`scripts/check-baileys-pin.mjs` fails if any package uses a range or a different version.

## Go / no-go criteria for 7.x (TEST-PLAN RL6, C14)
- Pairing works by pairing code (spike) and QR (connect screen).
- ≥72h on the test number without unexplained disconnects or decrypt failures.
- Send/receive text, media and voice in direct and group chats.
- Reconnect after a network drop and after a process restart without re-pairing (36h restart timer).
- No open critical upstream issue affecting the above.

## Fallback
If the spike fails: change the line above to `6.7.24`, pin every package to it, and record the failing
criteria and the baseline numbers (RL8) here.

## Spike results
_To be filled in from `pnpm -C spikes/baileys7 report` after the 72h run._
