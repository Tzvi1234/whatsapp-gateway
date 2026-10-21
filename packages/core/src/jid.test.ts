import { describe, expect, it } from 'vitest';
import { jidKind, normalizeJid } from './jid';
import { shouldAdvanceStatus } from './provider';

describe('normalizeJid', () => {
  it('strips device suffix from PN JIDs', () => {
    const r = normalizeJid('972559014410:12@s.whatsapp.net');
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'pn',
        jid: '972559014410@s.whatsapp.net',
        user: '972559014410',
        e164: '+972559014410',
      },
    });
  });

  it('accepts legacy @c.us', () => {
    const r = normalizeJid('972559014410@c.us');
    expect(r.ok && r.value.jid).toBe('972559014410@s.whatsapp.net');
  });

  it('normalises LID JIDs', () => {
    const r = normalizeJid('123456789012345:3@lid');
    expect(r.ok && r.value).toMatchObject({ kind: 'lid', jid: '123456789012345@lid', e164: null });
  });

  it('recognises groups and status broadcast', () => {
    expect(jidKind('1203630@g.us')).toBe('group');
    expect(jidKind('status@broadcast')).toBe('status');
    expect(normalizeJid('1203630@g.us').ok).toBe(true);
  });

  it('rejects junk', () => {
    expect(normalizeJid('abc@s.whatsapp.net').ok).toBe(false);
    expect(normalizeJid('@lid').ok).toBe(false);
    expect(normalizeJid('x@example.com').ok).toBe(false);
  });
});

describe('shouldAdvanceStatus', () => {
  it('R4.7 is forward-only and failed always wins', () => {
    expect(shouldAdvanceStatus('sent', 'delivered')).toBe(true);
    expect(shouldAdvanceStatus('delivered', 'sent')).toBe(false);
    expect(shouldAdvanceStatus('read', 'delivered')).toBe(false);
    expect(shouldAdvanceStatus('read', 'failed')).toBe(true);
    expect(shouldAdvanceStatus('failed', 'read')).toBe(false);
  });
});
