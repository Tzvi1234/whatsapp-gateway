import { DisconnectReason } from 'baileys';

/**
 * Reconnect policy (ARCH §4.6, TEST-PLAN RL4), ported from legacy whatsapp.ts:
 *  - restartRequired (515)              → reconnect immediately, backoff reset
 *  - loggedOut (401), badSession (500),
 *    multideviceMismatch (411)          → needs_relink: wipe store, alert, no retry
 *  - connectionReplaced (440),
 *    forbidden (403)                    → conflict: stop, alert P1, no auto-retry
 *  - anything else (408/428/503/none)   → reconnect with exponential backoff 1s→30s
 */
export type DisconnectAction = 'restart' | 'reconnect' | 'needs_relink' | 'conflict';

export function classifyDisconnect(code: number | undefined): DisconnectAction {
  switch (code) {
    case DisconnectReason.restartRequired:
      return 'restart';
    case DisconnectReason.loggedOut:
    case DisconnectReason.badSession:
    case DisconnectReason.multideviceMismatch:
      return 'needs_relink';
    case DisconnectReason.connectionReplaced:
    case DisconnectReason.forbidden:
      return 'conflict';
    default:
      return 'reconnect';
  }
}

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** attempt 0 → 1s, 1 → 2s, … capped at 30s. Deterministic (the pacing layer adds jitter). */
export function reconnectDelayMs(
  attempt: number,
  baseMs = RECONNECT_BASE_MS,
  maxMs = RECONNECT_MAX_MS,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
}

/** Extracts the numeric status code from a Boom / Error thrown or reported by Baileys. */
export function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { output?: { statusCode?: unknown }; statusCode?: unknown };
  const c = e.output?.statusCode ?? e.statusCode;
  return typeof c === 'number' ? c : undefined;
}
