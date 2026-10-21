/**
 * C11 spike pairing guard. Lives ONLY in the spike (no number blocklist in the provider).
 * Personal numbers come from env only (never code, tests or docs). Messages mask numbers.
 */
import path from 'node:path';
import { e164ToJid, maskPhone, toE164 } from '@htz/core';
import type { MasterKeyLocation, SelfIdentity } from '@htz/provider-baileys';
import { EXIT_CONFIG, EXIT_NUMBER_GUARD } from './exit-codes';

export interface SpikeConfig {
  spikeHome: string;
  accountId: string;
  pairingE164: string;
  testE164: string | null;
  blockedCount: number;
  keyLocation: MasterKeyLocation;
  /** 0 = note-to-self probe disabled. */
  probeIntervalMin: number;
  heartbeatSec: number;
  logLevel: string;
}

export type GuardResult<T> =
  { ok: true; value: T } | { ok: false; error: string; exitCode: number };

const refuse = (error: string, exitCode = EXIT_NUMBER_GUARD): GuardResult<never> => ({
  ok: false,
  error,
  exitCode,
});

/** Blocked entries: Israeli numbers via toE164; foreign `+digits` kept as-is (blocking more is safe). */
function normalizeBlocked(raw: string): string | null {
  const r = toE164(raw);
  if (r.ok) return r.value;
  const digits = raw.replace(/[\s\-().]/g, '');
  return /^\+\d{8,15}$/.test(digits) ? digits : null;
}

/**
 * C11: refuse to start if BLOCKED_NUMBERS is empty, PAIRING_NUMBER is missing/invalid or blocked,
 * or differs from TEST_NUMBER when that is set. All comparisons on toE164-normalised values.
 */
export function checkPairingGuard(input: {
  pairingNumber: string | undefined;
  testNumber: string | undefined;
  blockedNumbers: string | undefined;
}): GuardResult<{ pairingE164: string; testE164: string | null; blocked: string[] }> {
  const blockedRaw = (input.blockedNumbers ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (blockedRaw.length === 0) return refuse('BLOCKED_NUMBERS is empty');
  const blocked: string[] = [];
  for (const b of blockedRaw) {
    const n = normalizeBlocked(b);
    if (!n) return refuse('BLOCKED_NUMBERS contains an invalid entry');
    blocked.push(n);
  }

  if (!input.pairingNumber?.trim()) return refuse('PAIRING_NUMBER is missing');
  const pairing = toE164(input.pairingNumber);
  if (!pairing.ok) return refuse('PAIRING_NUMBER is not a valid number');
  if (blocked.includes(pairing.value))
    return refuse(`PAIRING_NUMBER ${maskPhone(pairing.value)} is in BLOCKED_NUMBERS`);

  let testE164: string | null = null;
  if (input.testNumber?.trim()) {
    const t = toE164(input.testNumber);
    if (!t.ok) return refuse('TEST_NUMBER is not a valid number');
    if (t.value !== pairing.value)
      return refuse(
        `PAIRING_NUMBER ${maskPhone(pairing.value)} does not match TEST_NUMBER ${maskPhone(t.value)}`,
      );
    testE164 = t.value;
  }
  return { ok: true, value: { pairingE164: pairing.value, testE164, blocked } };
}

export function loadSpikeConfig(
  env: Record<string, string | undefined>,
  homeDir: string,
): GuardResult<SpikeConfig> {
  const g = checkPairingGuard({
    pairingNumber: env.PAIRING_NUMBER,
    testNumber: env.TEST_NUMBER,
    blockedNumbers: env.BLOCKED_NUMBERS,
  });
  if (!g.ok) return g;

  const home = env.SPIKE_HOME?.trim() || path.join(homeDir, 'baileys-spike');
  const spikeHome = home.startsWith('~/') ? path.join(homeDir, home.slice(2)) : home;
  if (!path.isAbsolute(spikeHome)) return refuse('SPIKE_HOME must be absolute', EXIT_CONFIG);

  if (!env.SESSION_KEY_FILE && !env.CREDENTIALS_DIRECTORY)
    return refuse(
      'no session key: set SESSION_KEY_FILE or LoadCredential=session.key',
      EXIT_CONFIG,
    );

  const probe = Number(env.PROBE_INTERVAL_MIN ?? '0');
  if (!Number.isFinite(probe) || probe < 0)
    return refuse('PROBE_INTERVAL_MIN invalid', EXIT_CONFIG);
  if (probe > 0 && probe < 5) return refuse('PROBE_INTERVAL_MIN must be 0 or ≥ 5', EXIT_CONFIG);

  return {
    ok: true,
    value: {
      spikeHome,
      accountId: 'spike-baileys7',
      pairingE164: g.value.pairingE164,
      testE164: g.value.testE164,
      blockedCount: g.value.blocked.length,
      keyLocation: {
        keyFile: env.SESSION_KEY_FILE || undefined,
        credentialsDirectory: env.CREDENTIALS_DIRECTORY || undefined,
        credentialName: 'session.key',
      },
      probeIntervalMin: probe,
      heartbeatSec: 60,
      logLevel: env.LOG_LEVEL || 'info',
    },
  };
}

export type IdentityCheck =
  | { ok: true; lidVerified: boolean }
  | { ok: false; reason: 'pn_mismatch' | 'lid_mismatch' | 'unverifiable' };

/**
 * C11: after pairing, `me.id` must be the PAIRING_NUMBER — checked on the PN and on the LID
 * (through Baileys' lid-mapping). Fails closed when the identity cannot be verified.
 */
export async function checkPairedIdentity(
  me: SelfIdentity,
  pairingE164: string,
  pnForLid: (lid: string) => Promise<string | null>,
): Promise<IdentityCheck> {
  const expected = e164ToJid(pairingE164);
  if (me.pn && me.pn !== expected) return { ok: false, reason: 'pn_mismatch' };
  let lidPn: string | null = null;
  if (me.lid) {
    try {
      lidPn = await pnForLid(me.lid);
    } catch {
      lidPn = null;
    }
    if (lidPn && lidPn !== expected) return { ok: false, reason: 'lid_mismatch' };
  }
  if (!me.pn && !lidPn) return { ok: false, reason: 'unverifiable' };
  return { ok: true, lidVerified: lidPn !== null };
}
