import { describe, expect, it } from 'vitest';
import { matchConfigSchema, matchKeyword, type MatchConfig } from './matcher';
import { normalizeForMatch, stripNiqqud } from './text';

const cfg = (over: Partial<MatchConfig> = {}): MatchConfig =>
  matchConfigSchema.parse({ keywords: ['מחיר'], ...over });
const hit = (text: string, over: Partial<MatchConfig> = {}) =>
  matchKeyword(text, cfg(over)).matched;

describe('matchKeyword', () => {
  it('R1.3 exact vs contains', () => {
    expect(hit('מחיר', { mode: 'exact' })).toBe(true);
    expect(hit('מה המחיר?', { mode: 'exact' })).toBe(false);
    expect(hit('מה המחיר?', { mode: 'contains' })).toBe(true);
    expect(hit('משהו אחר', { mode: 'contains' })).toBe(false);
  });

  it('R1.3 case-insensitive by default, case-sensitive when set', () => {
    const k = { keywords: ['Price'] };
    expect(hit('what is the PRICE', k)).toBe(true);
    expect(hit('what is the PRICE', { ...k, caseSensitive: true })).toBe(false);
    expect(hit('what is the Price', { ...k, caseSensitive: true })).toBe(true);
    expect(hit('price', { ...k, mode: 'exact' })).toBe(true);
    expect(hit('price', { ...k, mode: 'exact', caseSensitive: true })).toBe(false);
  });

  it('R1.4 niqqud stripped in text and keyword', () => {
    expect(hit('מְחִיר', { mode: 'exact' })).toBe(true);
    expect(hit('מחיר', { mode: 'exact', keywords: ['מְחִיר'] })).toBe(true);
    expect(stripNiqqud('שָׁלוֹם')).toBe('שלום');
  });

  it('R1.4 final letters stay distinct (ם ≠ מ)', () => {
    expect(hit('שלום', { mode: 'exact', keywords: ['שלומ'] })).toBe(false);
    expect(hit('שלומ', { mode: 'exact', keywords: ['שלום'] })).toBe(false);
    expect(hit('שלום', { mode: 'exact', keywords: ['שלום'] })).toBe(true);
  });

  it('R1.5 ignoreEmoji on: emoji ignored in text and keyword', () => {
    expect(hit('מחיר 🔥🔥', { mode: 'exact', ignoreEmoji: true })).toBe(true);
    expect(hit('מחיר', { mode: 'exact', ignoreEmoji: true, keywords: ['מחיר 👍🏽'] })).toBe(true);
    expect(hit('👨\u200D👩\u200D👧 מחיר', { mode: 'exact', ignoreEmoji: true })).toBe(true);
  });

  it('R1.5 ignoreEmoji off: emoji are significant', () => {
    expect(hit('מחיר 🔥', { mode: 'exact', ignoreEmoji: false })).toBe(false);
    expect(hit('מחיר 🔥', { mode: 'exact', ignoreEmoji: false, keywords: ['מחיר 🔥'] })).toBe(true);
    expect(hit('🔥', { mode: 'exact', ignoreEmoji: false, keywords: ['🔥'] })).toBe(true);
    expect(hit('🔥', { mode: 'exact', ignoreEmoji: true, keywords: ['🔥'] })).toBe(false);
  });

  it('normalises whitespace and invisible marks', () => {
    expect(hit('  מה\n\tה  מחיר ', { mode: 'exact', keywords: ['מה ה מחיר'] })).toBe(true);
    expect(
      normalizeForMatch('\u200Fמחיר\u200E', { caseSensitive: false, ignoreEmoji: false }),
    ).toBe('מחיר');
  });

  it('empty text or empty-normalised keyword never matches', () => {
    expect(matchKeyword(null, cfg()).matched).toBe(false);
    expect(hit('anything', { keywords: ['🔥'], ignoreEmoji: true })).toBe(false);
  });

  it('returns the matching keyword', () => {
    expect(matchKeyword('כמה עולה', cfg({ keywords: ['מחיר', 'עולה'] }))).toEqual({
      matched: true,
      keyword: 'עולה',
    });
  });
});
