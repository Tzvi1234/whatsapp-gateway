import { describe, expect, it } from 'vitest';
import { contactKeys, type LidPnResolver } from './jid';
import { planPacing } from './pacing';
import {
  isCooldownActive,
  isDailyCapReached,
  isDirectChat,
  isStale,
  protectionSettingsSchema,
} from './protection';
import { countOnLocalDay, localDayKey, startOfLocalDay } from './time';

// Fictitious numbers only.
const PN = '972559014410@s.whatsapp.net';
const LID = '123456789012345@lid';
const resolver: LidPnResolver = {
  lidToPn: (l) => (l === LID ? PN : null),
  pnToLid: (p) => (p === PN ? LID : null),
};

describe('protection rules', () => {
  it('R2.1 only direct chats', () => {
    expect(isDirectChat(PN, false)).toBe(true);
    expect(isDirectChat(LID, false)).toBe(true);
    expect(isDirectChat('1203630@g.us', true)).toBe(false);
    expect(isDirectChat('1203630@g.us', false)).toBe(false);
    expect(isDirectChat('status@broadcast', false)).toBe(false);
    expect(isDirectChat(PN, true)).toBe(false);
  });

  it('R2.2 same person as LID and as PN yields overlapping cooldown keys', () => {
    const asLid = contactKeys(null, LID, resolver);
    const asPn = contactKeys(PN, null, resolver);
    expect(asLid).toEqual(['lid:123456789012345', 'pn:+972559014410']);
    expect(asPn).toEqual(asLid);
    expect(isCooldownActive(asPn, new Set(asLid.slice(0, 1)))).toBe(true);
  });

  it('R2.2 without a mapping, keys still overlap once both ids were recorded', () => {
    const first = contactKeys(PN, LID); // message carried both ids
    const later = contactKeys(null, '123456789012345:5@lid');
    expect(isCooldownActive(later, new Set(first))).toBe(true);
    expect(isCooldownActive(contactKeys('972500000001@s.whatsapp.net', null), new Set(first))).toBe(
      false,
    );
  });

  it('R2.3 older than 5 min is stale; unparseable is stale', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(isStale('2026-10-21T11:55:00Z', now, 300_000)).toBe(false);
    expect(isStale('2026-10-21T11:54:59Z', now, 300_000)).toBe(true);
    expect(isStale('garbage', now, 300_000)).toBe(true);
  });

  it('R2.4 daily cap resets at local midnight in Asia/Jerusalem', () => {
    const settings = protectionSettingsSchema.parse({ dailyCap: 2 });
    // 21:30Z = 00:30 local (IDT, UTC+3) on Oct 22; 20:30Z = 23:30 local on Oct 21.
    const sends = ['2026-10-21T20:00:00Z', '2026-10-21T20:30:00Z'];
    expect(isDailyCapReached(sends, Date.parse('2026-10-21T20:45:00Z'), settings)).toBe(true);
    expect(isDailyCapReached(sends, Date.parse('2026-10-21T21:00:00Z'), settings)).toBe(false);
    // UTC midnight is NOT the boundary
    const utcSends = ['2026-10-21T22:30:00Z', '2026-10-21T23:30:00Z'];
    expect(isDailyCapReached(utcSends, Date.parse('2026-10-22T00:30:00Z'), settings)).toBe(true);
  });

  it('R2.4 timezone is configurable and validated', () => {
    expect(protectionSettingsSchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(protectionSettingsSchema.parse({}).timezone).toBe('Asia/Jerusalem');
    expect(localDayKey('2026-10-21T22:00:00Z', 'UTC')).toBe('2026-10-21');
    expect(localDayKey('2026-10-21T22:00:00Z', 'Asia/Jerusalem')).toBe('2026-10-22');
  });

  it('startOfLocalDay handles DST (winter UTC+2 and summer UTC+3)', () => {
    expect(startOfLocalDay('2026-10-21T12:00:00Z').toISOString()).toBe('2026-10-20T21:00:00.000Z');
    expect(startOfLocalDay('2026-12-01T12:00:00Z').toISOString()).toBe('2026-11-30T22:00:00.000Z');
    expect(countOnLocalDay(['2026-12-01T00:00:00Z'], '2026-11-30T21:59:00Z')).toBe(0);
  });
});

describe('planPacing', () => {
  it('R2.5 delay within 1-10s, typing for part of it ending at send, mark-read at once', () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const p = planPacing({ now: 0, lastSentAt: null, rng: () => r });
      expect(p.delayMs).toBeGreaterThanOrEqual(1_000);
      expect(p.delayMs).toBeLessThanOrEqual(10_000);
      expect(p.markReadAtMs).toBe(0);
      expect(p.typingDurationMs).toBeGreaterThan(0);
      expect(p.typingDurationMs).toBeLessThan(p.delayMs);
      expect(p.typingStartAtMs + p.typingDurationMs).toBe(p.sendAtMs);
    }
  });

  it('R2.5 min gap between sends is respected', () => {
    const p = planPacing({
      now: 10_000,
      lastSentAt: 9_500,
      rng: () => 0,
      settings: { minGapMs: 5_000 },
    });
    expect(p.delayMs).toBe(1_000);
    expect(p.sendAtMs).toBe(4_500);
    const q = planPacing({ now: 100_000, lastSentAt: 0, rng: () => 0 });
    expect(q.sendAtMs).toBe(1_000);
  });
});
