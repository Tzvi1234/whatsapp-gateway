// C11 spike pairing guard. Fictitious numbers only.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG, EXIT_NUMBER_GUARD, RESTART_PREVENT_EXIT_STATUS } from '../src/exit-codes';
import { checkPairedIdentity, checkPairingGuard, loadSpikeConfig } from '../src/guard';
import { assertNoteToSelf } from '../src/probe';

const PAIR = '+972559014410';
const PAIR_LOCAL = '055-901-4410';
const OTHER = '0500000001';
const PAIR_JID = '972559014410@s.whatsapp.net';

describe('C11 checkPairingGuard', () => {
  it('C11 refuses when BLOCKED_NUMBERS is empty or missing', () => {
    for (const blockedNumbers of [undefined, '', ' , ,']) {
      const r = checkPairingGuard({ pairingNumber: PAIR, testNumber: undefined, blockedNumbers });
      expect(r).toMatchObject({ ok: false, exitCode: EXIT_NUMBER_GUARD });
    }
  });

  it('C11 refuses when PAIRING_NUMBER is missing or invalid', () => {
    expect(
      checkPairingGuard({ pairingNumber: undefined, testNumber: undefined, blockedNumbers: OTHER })
        .ok,
    ).toBe(false);
    expect(
      checkPairingGuard({ pairingNumber: ' ', testNumber: undefined, blockedNumbers: OTHER }).ok,
    ).toBe(false);
    expect(
      checkPairingGuard({ pairingNumber: 'abc', testNumber: undefined, blockedNumbers: OTHER }).ok,
    ).toBe(false);
  });

  it('C11 refuses when PAIRING_NUMBER is blocked, in any formatting', () => {
    for (const blocked of [PAIR, PAIR_LOCAL, '972559014410', `${OTHER}, 0559014410`]) {
      const r = checkPairingGuard({
        pairingNumber: '+972 55 901 4410',
        testNumber: undefined,
        blockedNumbers: blocked,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/BLOCKED_NUMBERS/);
        expect(r.error).not.toContain('559014410'); // masked
      }
    }
  });

  it('C11 refuses when PAIRING_NUMBER ≠ TEST_NUMBER (normalised)', () => {
    const r = checkPairingGuard({
      pairingNumber: PAIR,
      testNumber: OTHER,
      blockedNumbers: '0500000002',
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/does not match TEST_NUMBER/);
  });

  it('C11 accepts when TEST_NUMBER equals PAIRING_NUMBER in another format', () => {
    const r = checkPairingGuard({
      pairingNumber: PAIR,
      testNumber: PAIR_LOCAL,
      blockedNumbers: OTHER,
    });
    expect(r).toEqual({
      ok: true,
      value: { pairingE164: PAIR, testE164: PAIR, blocked: ['+972500000001'] },
    });
  });

  it('C11 fails closed on an invalid blocked entry; allows foreign +E.164 entries', () => {
    expect(
      checkPairingGuard({ pairingNumber: PAIR, testNumber: undefined, blockedNumbers: 'nope' }).ok,
    ).toBe(false);
    expect(
      checkPairingGuard({
        pairingNumber: PAIR,
        testNumber: undefined,
        blockedNumbers: '+1 415 555 0100',
      }).ok,
    ).toBe(true);
  });
});

describe('loadSpikeConfig', () => {
  const base = { PAIRING_NUMBER: PAIR, BLOCKED_NUMBERS: OTHER, SESSION_KEY_FILE: '/run/k' };

  it('defaults SPIKE_HOME to ~/baileys-spike and accepts $CREDENTIALS_DIRECTORY', () => {
    const r = loadSpikeConfig(
      { PAIRING_NUMBER: PAIR, BLOCKED_NUMBERS: OTHER, CREDENTIALS_DIRECTORY: '/run/credentials/x' },
      '/home/u',
    );
    expect(r.ok && r.value.spikeHome).toBe('/home/u/baileys-spike');
    expect(r.ok && r.value.keyLocation).toMatchObject({
      credentialsDirectory: '/run/credentials/x',
    });
  });

  it('requires a key source and a sane probe interval', () => {
    expect(loadSpikeConfig({ PAIRING_NUMBER: PAIR, BLOCKED_NUMBERS: OTHER }, '/h')).toMatchObject({
      ok: false,
      exitCode: EXIT_CONFIG,
    });
    expect(loadSpikeConfig({ ...base, PROBE_INTERVAL_MIN: '1' }, '/h').ok).toBe(false);
    expect(loadSpikeConfig({ ...base, PROBE_INTERVAL_MIN: '15' }, '/h')).toMatchObject({
      ok: true,
      value: { probeIntervalMin: 15 },
    });
    expect(loadSpikeConfig({ ...base, SPIKE_HOME: '~/x' }, '/h')).toMatchObject({
      ok: true,
      value: { spikeHome: '/h/x' },
    });
  });

  it('runs the guard first', () => {
    expect(loadSpikeConfig({ ...base, BLOCKED_NUMBERS: '' }, '/h')).toMatchObject({
      ok: false,
      exitCode: EXIT_NUMBER_GUARD,
    });
  });
});

describe('C11 checkPairedIdentity (after pairing)', () => {
  const noLid = async () => null;

  it('accepts matching PN and LID', async () => {
    const r = await checkPairedIdentity(
      { pn: PAIR_JID, lid: '123456789@lid' },
      PAIR,
      async () => PAIR_JID,
    );
    expect(r).toEqual({ ok: true, lidVerified: true });
  });

  it('rejects a PN mismatch', async () => {
    const r = await checkPairedIdentity(
      { pn: '972500000001@s.whatsapp.net', lid: null },
      PAIR,
      noLid,
    );
    expect(r).toEqual({ ok: false, reason: 'pn_mismatch' });
  });

  it('rejects a LID that maps to another number', async () => {
    const r = await checkPairedIdentity(
      { pn: PAIR_JID, lid: '123456789@lid' },
      PAIR,
      async () => '972500000001@s.whatsapp.net',
    );
    expect(r).toEqual({ ok: false, reason: 'lid_mismatch' });
  });

  it('fails closed when identity cannot be verified', async () => {
    expect(await checkPairedIdentity({ pn: null, lid: '123456789@lid' }, PAIR, noLid)).toEqual({
      ok: false,
      reason: 'unverifiable',
    });
    expect(await checkPairedIdentity({ pn: null, lid: null }, PAIR, noLid)).toEqual({
      ok: false,
      reason: 'unverifiable',
    });
  });

  it('PN match with unknown LID mapping passes but is reported unverified', async () => {
    expect(await checkPairedIdentity({ pn: PAIR_JID, lid: '123456789@lid' }, PAIR, noLid)).toEqual({
      ok: true,
      lidVerified: false,
    });
  });
});

describe('probe + exit codes', () => {
  it('assertNoteToSelf only allows the own JID', () => {
    expect(assertNoteToSelf('972559014410:3@s.whatsapp.net', PAIR_JID)).toBe(PAIR_JID);
    expect(() => assertNoteToSelf('972500000001@s.whatsapp.net', PAIR_JID)).toThrow(
      /note_to_self_violation/,
    );
  });

  it('systemd RestartPreventExitStatus covers every terminal exit code', () => {
    expect(RESTART_PREVENT_EXIT_STATUS.split(' ').map(Number).sort()).toEqual([
      41, 42, 43, 44, 50, 78,
    ]);
    const unit = fs.readFileSync(
      new URL('../deploy/baileys-spike.service', import.meta.url),
      'utf8',
    );
    expect(unit).toContain(`RestartPreventExitStatus=${RESTART_PREVENT_EXIT_STATUS}`);
    expect(unit).toMatch(/^UMask=0077$/m);
    expect(unit).toMatch(/^LoadCredential=session\.key:/m);
    expect(unit).toMatch(/^ProtectSystem=strict$/m);
    expect(unit).toMatch(/^ReadWritePaths=%h\/baileys-spike$/m);
  });
});
