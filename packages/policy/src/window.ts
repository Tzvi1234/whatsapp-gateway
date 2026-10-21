/** Cloud API customer-service window (ARCH §7.6). */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const toMs = (v: string | Date | number): number =>
  v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);

/** True when the last inbound message is less than 24h old. Unknown/invalid → false (fail closed). */
export function isWithin24hWindow(
  lastInboundAt: string | Date | number | null | undefined,
  now: string | Date | number,
): boolean {
  if (lastInboundAt === null || lastInboundAt === undefined) return false;
  const last = toMs(lastInboundAt);
  const n = toMs(now);
  if (!Number.isFinite(last) || !Number.isFinite(n)) return false;
  return n - last < SERVICE_WINDOW_MS;
}
