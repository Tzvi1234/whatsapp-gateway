import { z } from 'zod';

export const pacingSettingsSchema = z.object({
  minDelayMs: z.number().int().min(0).default(1_000),
  maxDelayMs: z.number().int().min(0).default(10_000),
  /** Fraction range of the delay during which "typing" is shown (ends at send time). */
  typingMinFraction: z.number().min(0).max(1).default(0.3),
  typingMaxFraction: z.number().min(0).max(1).default(0.8),
  /** Minimum gap between two sends on the account. */
  minGapMs: z.number().int().min(0).default(3_000),
});

export type PacingSettings = z.infer<typeof pacingSettingsSchema>;
export const DEFAULT_PACING: PacingSettings = pacingSettingsSchema.parse({});

/** Offsets in ms from `now`. */
export interface PacingPlan {
  markReadAtMs: number;
  typingStartAtMs: number;
  typingDurationMs: number;
  sendAtMs: number;
  /** Random human delay before any gap adjustment. */
  delayMs: number;
}

/**
 * Human-like pacing (R2.5): mark read at once, random 1–10s delay, typing shown for the last
 * part of it, and never closer than `minGapMs` to the previous send. Pure; RNG injected.
 */
export function planPacing(input: {
  now: number;
  lastSentAt: number | null;
  rng: () => number;
  settings?: Partial<PacingSettings>;
}): PacingPlan {
  const s = { ...DEFAULT_PACING, ...input.settings };
  const lo = Math.min(s.minDelayMs, s.maxDelayMs);
  const hi = Math.max(s.minDelayMs, s.maxDelayMs);
  const r1 = Math.min(Math.max(input.rng(), 0), 1);
  const r2 = Math.min(Math.max(input.rng(), 0), 1);
  const delayMs = Math.round(lo + r1 * (hi - lo));
  const gapFloor = input.lastSentAt === null ? 0 : input.lastSentAt + s.minGapMs - input.now;
  const sendAtMs = Math.max(delayMs, gapFloor);
  const fLo = Math.min(s.typingMinFraction, s.typingMaxFraction);
  const fHi = Math.max(s.typingMinFraction, s.typingMaxFraction);
  const typingDurationMs = Math.round(delayMs * (fLo + r2 * (fHi - fLo)));
  return {
    markReadAtMs: 0,
    typingStartAtMs: sendAtMs - typingDurationMs,
    typingDurationMs,
    sendAtMs,
    delayMs,
  };
}
