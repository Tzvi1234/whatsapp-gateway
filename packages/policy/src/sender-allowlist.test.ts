import { describe, expect, it } from 'vitest';
import { matchAllowedSender, normalizeAllowlist } from './sender-allowlist';

// Fictitious numbers only.
const OWNER = '+972559014410';
const OWNER_LID = '123456789012345@lid';
const allowlist = ['055-901-4410'];
const lidMap = (lid: string) => (lid === OWNER_LID ? '972559014410@s.whatsapp.net' : null);
const base = { senderPn: null, senderLid: null, fromMe: false, isGroup: false };

describe('matchAllowedSender', () => {
  it('L1.1 matches the allowlisted number as a PN JID', () => {
    const m = matchAllowedSender(
      { ...base, senderPn: '972559014410:3@s.whatsapp.net' },
      allowlist,
      lidMap,
    );
    expect(m).toEqual({ allowed: true, e164: OWNER, matchedVia: 'pn' });
  });

  it('L1.2 matches the allowlisted number seen only as a LID via the mapping', () => {
    const m = matchAllowedSender(
      { ...base, senderLid: '123456789012345:7@lid' },
      allowlist,
      lidMap,
    );
    expect(m).toEqual({ allowed: true, e164: OWNER, matchedVia: 'lid' });
  });

  it('L1.3 rejects a non-allowlisted PN and an unmapped LID', () => {
    expect(
      matchAllowedSender({ ...base, senderPn: '972500000001@s.whatsapp.net' }, allowlist, lidMap),
    ).toEqual({ allowed: false, reason: 'unknown_sender' });
    expect(matchAllowedSender({ ...base, senderLid: '999@lid' }, allowlist, lidMap)).toEqual({
      allowed: false,
      reason: 'unknown_sender',
    });
  });

  it('L1.4 never matches fromMe, even from the allowlisted number', () => {
    const m = matchAllowedSender(
      { ...base, senderPn: '972559014410@s.whatsapp.net', fromMe: true },
      allowlist,
      lidMap,
    );
    expect(m).toEqual({ allowed: false, reason: 'from_me' });
  });

  it('L1.5 never matches group traffic, even from the allowlisted number', () => {
    const m = matchAllowedSender(
      { ...base, senderPn: '972559014410@s.whatsapp.net', isGroup: true },
      allowlist,
      lidMap,
    );
    expect(m).toEqual({ allowed: false, reason: 'group' });
  });

  it('L1.3 empty allowlist or no sender ids fails closed', () => {
    expect(matchAllowedSender({ ...base, senderPn: OWNER }, [], lidMap).allowed).toBe(false);
    expect(matchAllowedSender(base, allowlist, lidMap).allowed).toBe(false);
  });

  it('normalises allowlist entries and drops junk', () => {
    expect([...normalizeAllowlist(['0559014410', '+972 55 901 4410', 'junk'])]).toEqual([OWNER]);
  });
});
