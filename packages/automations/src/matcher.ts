import { z } from 'zod';
import { normalizeForMatch } from './text';

export const matchConfigSchema = z.object({
  keywords: z.array(z.string().min(1).max(200)).min(1).max(50),
  mode: z.enum(['exact', 'contains']).default('contains'),
  caseSensitive: z.boolean().default(false),
  ignoreEmoji: z.boolean().default(true),
});

export type MatchConfig = z.infer<typeof matchConfigSchema>;
export type MatchMode = MatchConfig['mode'];

export type MatchResult = { matched: true; keyword: string } | { matched: false };

/**
 * Keyword match (TEST-PLAN R1.3-R1.5): `exact` compares the whole normalised text,
 * `contains` a substring. Niqqud is always stripped (final letters stay distinct);
 * emoji are removed only when `ignoreEmoji`. A keyword that normalises to empty never matches.
 */
export function matchKeyword(text: string | null | undefined, cfg: MatchConfig): MatchResult {
  if (!text) return { matched: false };
  const opts = { caseSensitive: cfg.caseSensitive, ignoreEmoji: cfg.ignoreEmoji };
  const hay = normalizeForMatch(text, opts);
  if (!hay) return { matched: false };
  for (const keyword of cfg.keywords) {
    const needle = normalizeForMatch(keyword, opts);
    if (!needle) continue;
    if (cfg.mode === 'exact' ? hay === needle : hay.includes(needle)) {
      return { matched: true, keyword };
    }
  }
  return { matched: false };
}
