import { describe, expect, it } from 'vitest';
import { formatE164ForDisplay, maskPhone, toE164 } from './phone';
import { normalizeJid } from './jid';

// Fictitious numbers only.
const EXPECTED = '+972559014410';

describe('toE164', () => {
  it.each([
    '0559014410',
    '055-901-4410',
    '+972 55 901 4410',
    '972559014410',
    '+972-055-901-4410',
    '00972559014410',
  ])('C7 normalises %s', (input) => {
    expect(toE164(input)).toEqual({ ok: true, value: EXPECTED });
  });

  it('C7 normalises landlines', () => {
    expect(toE164('03-555-0142')).toEqual({ ok: true, value: '+97235550142' });
  });

  it.each([
    '',
    'abc',
    '055901',
    '12345',
    '+1 415 555 0100',
    '05590144101234',
    '0659014410',
    'DROP TABLE',
  ])('C7 rejects %s', (input) => {
    const r = toE164(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_number');
  });

  it('C7 screen, API and normalizeJid give identical results', () => {
    const viaJid = normalizeJid('055-901-4410');
    expect(viaJid.ok && viaJid.value.e164).toBe(EXPECTED);
    expect(viaJid.ok && viaJid.value.jid).toBe('972559014410@s.whatsapp.net');
  });

  it('formats and masks for display', () => {
    expect(formatE164ForDisplay(EXPECTED)).toBe('+972 55-901-4410');
    expect(maskPhone(EXPECTED)).toBe('…4410');
  });
});
