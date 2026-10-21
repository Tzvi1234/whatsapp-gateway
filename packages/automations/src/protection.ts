import { jidKind } from '@htz/core';
import { z } from 'zod';
import { countOnLocalDay, DEFAULT_TIMEZONE, isValidTimeZone } from './time';

/** Ported protection-rule settings (WA-Automation `policy.ts`, ARCH §9.3 item 2). */
export const protectionSettingsSchema = z.object({
  /** Skip status replies older than this. Default 5 min. */
  maxAgeMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  /** Max automated replies per account per local day. */
  dailyCap: z.number().int().min(0).default(50),
  /** IANA zone whose midnight resets the daily cap. */
  timezone: z.string().refine(isValidTimeZone, 'invalid IANA timezone').default(DEFAULT_TIMEZONE),
});

export type ProtectionSettings = z.infer<typeof protectionSettingsSchema>;
export const DEFAULT_PROTECTION: ProtectionSettings = protectionSettingsSchema.parse({});

export const SKIP_REASONS = [
  'skipped_disabled',
  'skipped_from_me',
  'skipped_not_direct',
  'skipped_not_status_reply',
  'skipped_status_mismatch',
  'skipped_stale',
  'skipped_no_match',
  'skipped_cooldown',
  'skipped_cap',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Direct 1:1 chat (PN or LID), never groups/status/newsletters (R2.1). */
export function isDirectChat(chatJid: string, isGroup: boolean): boolean {
  if (isGroup) return false;
  const k = jidKind(chatJid);
  return k === 'pn' || k === 'lid';
}

/** Older than `maxAgeMs` (R2.3). Unparseable timestamps count as stale (fail closed). */
export function isStale(messageAt: string | number, now: number, maxAgeMs: number): boolean {
  const t = typeof messageAt === 'number' ? messageAt : Date.parse(messageAt);
  if (!Number.isFinite(t)) return true;
  return now - t > maxAgeMs;
}

/** Any identity key of this contact already used the cooldown (R2.2). */
export function isCooldownActive(keys: readonly string[], used: ReadonlySet<string>): boolean {
  return keys.some((k) => used.has(k));
}

/** Daily cap with the boundary at local midnight in `timezone` (R2.4). */
export function isDailyCapReached(
  sendTimestamps: readonly (string | number)[],
  now: number,
  settings: Pick<ProtectionSettings, 'dailyCap' | 'timezone'>,
): boolean {
  return countOnLocalDay(sendTimestamps, now, settings.timezone) >= settings.dailyCap;
}
