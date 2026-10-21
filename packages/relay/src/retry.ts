/** Generic outbound webhook retry schedule (ARCH §4.7): 10s, 30s, 2m, 10m, 30m, 2h, then dead. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  10_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000,
] as const;

/** Max retries after the first attempt. */
export const WEBHOOK_MAX_RETRIES = WEBHOOK_RETRY_DELAYS_MS.length;
/** Total attempts including the first POST. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_MAX_RETRIES + 1;

export type RetryDecision = { action: 'retry'; delayMs: number } | { action: 'dead' };

/**
 * Next step after `attemptsMade` failed POSTs (1 = the first POST failed).
 * Jitter: ±`jitter` fraction of the base delay using the injected RNG ([0,1)).
 */
export function nextWebhookRetry(
  attemptsMade: number,
  rng: () => number = Math.random,
  jitter = 0.2,
): RetryDecision {
  const base = WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1];
  if (attemptsMade < 1 || base === undefined) return { action: 'dead' };
  const factor = 1 + (rng() * 2 - 1) * jitter;
  return { action: 'retry', delayMs: Math.max(1_000, Math.round(base * factor)) };
}
