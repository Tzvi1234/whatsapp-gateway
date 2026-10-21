import { describe, expect, it } from 'vitest';
import {
  automationSchema,
  evaluateStatusReplies,
  evaluateStatusReply,
  type StatusReplyInput,
} from './engine';
import type { LidPnResolver } from './jid';

// Fictitious numbers only.
const PN = '972559014410@s.whatsapp.net';
const LID = '123456789012345@lid';
const NOW = '2026-10-21T12:00:00.000Z';
const resolver: LidPnResolver = {
  lidToPn: (l) => (l === LID ? PN : null),
  pnToLid: (p) => (p === PN ? LID : null),
};

const automation = automationSchema.parse({
  id: 'auto-1',
  enabled: true,
  match: { keywords: ['מחיר'], mode: 'contains' },
  reply: { text: 'היי {name}, המחיר 100' },
  binding: { mode: 'specific', statusId: 'st-1' },
});

const input = (over: Partial<StatusReplyInput> = {}): StatusReplyInput => ({
  automation,
  boundStatusId: null,
  message: {
    chatJid: PN,
    isGroup: false,
    fromMe: false,
    senderPn: PN,
    senderLid: null,
    text: 'מה המחיר?',
    timestamp: '2026-10-21T11:59:30.000Z',
    statusReplyToId: 'st-1',
    pushName: 'דנה',
  },
  now: NOW,
  state: { usedCooldownKeys: new Set(), sendTimestamps: [], lastSentAt: null },
  capabilities: { nativeButtons: 'unsupported', lists: 'unsupported' },
  resolver,
  rng: () => 0.5,
  ...over,
});
const msg = (over: Partial<StatusReplyInput['message']>) => ({ ...input().message, ...over });

describe('evaluateStatusReply', () => {
  it('R1.1 matching reply to the bound status → one reply in the same direct chat', () => {
    const d = evaluateStatusReply(input());
    expect(d.action).toBe('reply');
    if (d.action === 'reply') {
      expect(d.to).toBe(PN);
      expect(d.statusId).toBe('st-1');
      expect(d.reply.text).toBe('היי דנה, המחיר 100');
      expect(d.cooldownKeys).toEqual([
        'auto-1|st-1|lid:123456789012345',
        'auto-1|st-1|pn:+972559014410',
      ]);
      expect(d.pacing.sendAtMs).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('R1.10 disabled automation → skipped_disabled', () => {
    const d = evaluateStatusReply(input({ automation: { ...automation, enabled: false } }));
    expect(d).toMatchObject({ action: 'skip', reason: 'skipped_disabled' });
  });

  it('R2.1 group or non-direct chat → skipped_not_direct', () => {
    expect(
      evaluateStatusReply(input({ message: msg({ chatJid: '1203630@g.us', isGroup: true }) })),
    ).toMatchObject({ reason: 'skipped_not_direct' });
    expect(
      evaluateStatusReply(input({ message: msg({ chatJid: 'status@broadcast' }) })),
    ).toMatchObject({
      reason: 'skipped_not_direct',
    });
  });

  it('R2.2 second reply from the same person seen as LID is skipped_cooldown', () => {
    const first = evaluateStatusReply(input());
    if (first.action !== 'reply') throw new Error('expected reply');
    const second = evaluateStatusReply(
      input({
        message: msg({ chatJid: LID, senderPn: null, senderLid: LID }),
        state: {
          usedCooldownKeys: new Set(first.cooldownKeys),
          sendTimestamps: [NOW],
          lastSentAt: NOW,
        },
      }),
    );
    expect(second).toMatchObject({ action: 'skip', reason: 'skipped_cooldown' });
  });

  it('R2.2 cooldown is per status: same contact on another status is allowed', () => {
    const first = evaluateStatusReply(input());
    if (first.action !== 'reply') throw new Error('expected reply');
    const other = automationSchema.parse({
      ...automation,
      binding: { mode: 'specific', statusId: 'st-2' },
    });
    const d = evaluateStatusReply(
      input({
        automation: other,
        message: msg({ statusReplyToId: 'st-2' }),
        state: {
          usedCooldownKeys: new Set(first.cooldownKeys),
          sendTimestamps: [],
          lastSentAt: null,
        },
      }),
    );
    expect(d.action).toBe('reply');
  });

  it('R2.3 message older than 5 min → skipped_stale', () => {
    expect(
      evaluateStatusReply(input({ message: msg({ timestamp: '2026-10-21T11:54:59.000Z' }) })),
    ).toMatchObject({ reason: 'skipped_stale' });
  });

  it('R2.4 daily cap reached → skipped_cap; resets the next local day', () => {
    const state = {
      usedCooldownKeys: new Set<string>(),
      sendTimestamps: ['2026-10-21T20:10:00Z', '2026-10-21T20:20:00Z'],
      lastSentAt: '2026-10-21T20:20:00Z',
    };
    const at = (now: string) =>
      evaluateStatusReply(
        input({
          now,
          state,
          protection: { dailyCap: 2 },
          message: msg({ timestamp: new Date(Date.parse(now) - 1_000).toISOString() }),
        }),
      );
    expect(at('2026-10-21T20:50:00Z')).toMatchObject({ reason: 'skipped_cap' });
    expect(at('2026-10-21T21:05:00Z').action).toBe('reply'); // 00:05 local
  });

  it('R1.3 no keyword match → skipped_no_match; not a status reply / other status → skipped', () => {
    expect(evaluateStatusReply(input({ message: msg({ text: 'שלום' }) }))).toMatchObject({
      reason: 'skipped_no_match',
    });
    expect(evaluateStatusReply(input({ message: msg({ statusReplyToId: null }) }))).toMatchObject({
      reason: 'skipped_not_status_reply',
    });
    expect(evaluateStatusReply(input({ message: msg({ statusReplyToId: 'st-9' }) }))).toMatchObject(
      {
        reason: 'skipped_status_mismatch',
      },
    );
  });

  it('fromMe is never answered', () => {
    expect(evaluateStatusReply(input({ message: msg({ fromMe: true }) }))).toMatchObject({
      reason: 'skipped_from_me',
    });
  });

  it('R1.2 "next" binding uses the resolved status; unbound → skipped_status_mismatch', () => {
    const nextAuto = automationSchema.parse({
      ...automation,
      binding: { mode: 'next', armedAt: '2026-10-21T11:50:00.000Z' },
    });
    expect(evaluateStatusReply(input({ automation: nextAuto, boundStatusId: null }))).toMatchObject(
      {
        reason: 'skipped_status_mismatch',
      },
    );
    expect(evaluateStatusReply(input({ automation: nextAuto, boundStatusId: 'st-1' })).action).toBe(
      'reply',
    );
  });

  it('R1.9 native requested on an unsupported account → fallback numbered text', () => {
    const a = automationSchema.parse({
      ...automation,
      reply: { text: 'בחר:', nativeButtons: true, options: [{ label: 'א' }, { label: 'ב' }] },
    });
    const d = evaluateStatusReply(input({ automation: a }));
    expect(d.action === 'reply' && d.reply).toMatchObject({
      deliveryMode: 'fallback',
      text: 'בחר:\n\n1. א\n2. ב',
    });
  });

  it('evaluateStatusReplies: first reply wins, skips kept for the log', () => {
    const disabled = { ...automation, id: 'auto-0', enabled: false };
    const r = evaluateStatusReplies(
      [
        { automation: disabled, boundStatusId: null },
        { automation, boundStatusId: null },
      ],
      input(),
    );
    expect(r.reply?.automationId).toBe('auto-1');
    expect(r.skips).toEqual([
      { action: 'skip', reason: 'skipped_disabled', automationId: 'auto-0' },
    ]);
  });
});
