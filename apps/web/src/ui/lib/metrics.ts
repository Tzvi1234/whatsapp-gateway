import type { MetricRow } from '@/server/actions/read-models';
import { jerusalemDay } from './time';

/** Small, pure aggregations over the `v_*` metric rows (ARCH §8.4). */

/** Threshold shown next to "נכשלו" on the home metrics row (mockup: "סף 2%"). */
export const FAILED_RATE_THRESHOLD = 0.02;

export function num(row: MetricRow | undefined, key: string): number | null {
  if (!row) return null;
  const v = row[key];
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const str = (row: MetricRow | undefined, key: string): string | null => {
  const v = row?.[key];
  return v === null || v === undefined ? null : String(v);
};

export function quantile(values: number[], q: number): number | null {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

export const median = (values: number[]) => quantile(values, 0.5);

/** Rows whose `day` column is the given Jerusalem day (default today). */
export function rowsForDay(rows: MetricRow[], day = jerusalemDay(Date.now())): MetricRow[] {
  return rows.filter((r) => {
    const d = str(r, 'day');
    return d !== null && jerusalemDay(d) === day;
  });
}

/** Rows of the most recent `day` present. */
export function latestDayRows(rows: MetricRow[]): MetricRow[] {
  let best: string | null = null;
  for (const r of rows) {
    const d = str(r, 'day');
    if (d && (!best || Date.parse(d) > Date.parse(best))) best = d;
  }
  return best ? rows.filter((r) => str(r, 'day') === best) : [];
}

/** n-weighted mean of a percentile column across rows (an approximation across groups). */
export function weighted(rows: MetricRow[], key: string, weightKey = 'n'): number | null {
  let sum = 0;
  let w = 0;
  for (const r of rows) {
    const v = num(r, key);
    const n = num(r, weightKey) ?? 1;
    if (v === null) continue;
    sum += v * n;
    w += n;
  }
  return w > 0 ? sum / w : null;
}

export interface FailedTotals {
  total: number;
  failed: number;
  rate: number | null;
}

export function failedTotals(
  rows: { provider: string; window: string; total: number; failed: number }[],
  window = '24h',
  provider?: string,
): FailedTotals {
  let total = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.window !== window) continue;
    if (provider && r.provider !== provider) continue;
    total += r.total;
    failed += r.failed;
  }
  return { total, failed, rate: total > 0 ? failed / total : null };
}

export const TRANSCRIPT_BUCKETS = ['0-15s', '15-30s', '30-60s', '60-120s', '120s+'] as const;

/** Per-bucket p50/p90 (seconds) for one account or all, n-weighted across accounts. */
export function transcriptByBucket(rows: MetricRow[], accountId?: string) {
  const sel = accountId ? rows.filter((r) => str(r, 'account_id') === accountId) : rows;
  return TRANSCRIPT_BUCKETS.map((b) => {
    const rs = sel.filter((r) => str(r, 'length_bucket') === b);
    const n = rs.reduce((s, r) => s + (num(r, 'n') ?? 0), 0);
    return { bucket: b, n, p50: weighted(rs, 'p50_s'), p90: weighted(rs, 'p90_s') };
  }).filter((x) => x.n > 0);
}

/** Bar width in percent relative to the largest value (min 2% so a bar is visible). */
export function barPct(value: number | null, max: number | null): number {
  if (value === null || max === null || max <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}
