import { z } from 'zod';

export const STATUS_NOTIFY_WINDOW_MS = 10 * 60_000;

export const statusBindingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('specific'), statusId: z.string().min(1) }),
  z.object({
    mode: z.literal('next'),
    /** When the automation was armed ("next status I post"). */
    armedAt: z.string().datetime({ offset: true }),
    notifyWindowMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000)
      .default(STATUS_NOTIFY_WINDOW_MS),
  }),
]);

export type StatusBinding = z.infer<typeof statusBindingSchema>;

export interface PostedStatus {
  id: string;
  postedAt: string;
}

export type BindResult =
  | { bound: true; statusId: string }
  | { bound: false; reason: 'id_mismatch' | 'before_arming' | 'outside_window' | 'invalid_time' };

/** Would this freshly posted status bind to the automation? (R1.1/R1.2) */
export function bindsTo(binding: StatusBinding, status: PostedStatus): BindResult {
  if (binding.mode === 'specific') {
    return binding.statusId === status.id
      ? { bound: true, statusId: status.id }
      : { bound: false, reason: 'id_mismatch' };
  }
  const armed = Date.parse(binding.armedAt);
  const posted = Date.parse(status.postedAt);
  if (!Number.isFinite(armed) || !Number.isFinite(posted)) {
    return { bound: false, reason: 'invalid_time' };
  }
  if (posted < armed) return { bound: false, reason: 'before_arming' };
  if (posted - armed > binding.notifyWindowMs) return { bound: false, reason: 'outside_window' };
  return { bound: true, statusId: status.id };
}

/**
 * Resolve "next status I post": the FIRST status posted at/after arming within the notify
 * window. Older statuses never bind; later ones do not steal an existing binding.
 */
export function resolveBoundStatus(
  binding: StatusBinding,
  statuses: readonly PostedStatus[],
): string | null {
  if (binding.mode === 'specific') return binding.statusId;
  const candidates = statuses
    .filter((s) => bindsTo(binding, s).bound)
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  return candidates[0]?.id ?? null;
}
