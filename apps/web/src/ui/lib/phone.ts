import { formatE164ForDisplay, toE164 } from '@htz/core';

/**
 * Live phone-input correction (C7, PLAN decision 11): a local number like `055-901-4410` is
 * shown as the number we will save (`+972 55-901-4410`), never as an error. Uses the same
 * `toE164()` as the server, so screen and API agree. An error is shown only once the input is
 * clearly wrong (bad characters, too long, or a complete-length number that still fails).
 */
export type PhoneCorrection =
  | { state: 'empty' }
  | { state: 'typing' }
  | { state: 'corrected'; e164: string; display: string; changed: boolean }
  | { state: 'invalid' };

export function correctPhone(input: string): PhoneCorrection {
  const raw = input.trim();
  if (!raw) return { state: 'empty' };
  const r = toE164(raw);
  if (r.ok) {
    const display = formatE164ForDisplay(r.value);
    return { state: 'corrected', e164: r.value, display, changed: raw !== display };
  }
  if (!/^[+\d\s\-().]+$/.test(raw) || raw.length > 20) return { state: 'invalid' };
  const digits = raw.replace(/\D/g, '');
  const hasPlus = raw.startsWith('+');
  // Still typing: fewer digits than a full Israeli number in either local or +972 form.
  const complete = hasPlus || digits.startsWith('972') ? digits.length >= 12 : digits.length >= 10;
  if (hasPlus && digits.length >= 3 && !digits.startsWith('972')) return { state: 'invalid' };
  return complete ? { state: 'invalid' } : { state: 'typing' };
}

/** `972559014410@s.whatsapp.net` → `+972 55-901-4410`; groups and unknown → null. */
export function displayFromJid(jid: string): string | null {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  if (!m) return null;
  return formatE164ForDisplay(`+${m[1]}`);
}

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
