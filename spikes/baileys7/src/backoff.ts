/** Exponential backoff 1s..60s with full jitter. */
export function nextBackoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * exp);
}
