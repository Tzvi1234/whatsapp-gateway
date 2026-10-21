/** Hebrew points and cantillation (U+0591–U+05C7). Final letters (U+05DA…) are outside this range. */
const NIQQUD = /[\u0591-\u05C7]/g;

/** Emoji: pictographs plus the joiners/modifiers that build sequences. */
const EMOJI =
  /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u200D|\uFE0E|\uFE0F|\u20E3/gu;

/** Bidi/zero-width marks that WhatsApp clients insert invisibly. */
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function stripNiqqud(s: string): string {
  return s.normalize('NFC').replace(NIQQUD, '');
}

export function stripEmoji(s: string): string {
  return s.replace(EMOJI, '');
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

export interface NormalizeOptions {
  caseSensitive: boolean;
  ignoreEmoji: boolean;
}

/** The single normaliser applied to both keyword and incoming text before matching. */
export function normalizeForMatch(s: string, opts: NormalizeOptions): string {
  let out = stripNiqqud(s).replace(INVISIBLE, '');
  if (opts.ignoreEmoji) out = stripEmoji(out);
  out = normalizeWhitespace(out);
  return opts.caseSensitive ? out : out.toLowerCase();
}
