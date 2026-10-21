/** Display helpers: always Asia/Jerusalem, 24h clock, compact durations (pure, testable). */

export const TZ = 'Asia/Jerusalem';

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
});
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toDate(v: string | number | Date): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `14:05` in Jerusalem time. */
export function formatTime(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined) return '';
  const d = toDate(v);
  return d ? timeFmt.format(d) : '';
}

/** `21.10 14:05` in Jerusalem time (mockup format). */
export function formatDateTime(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined) return '';
  const d = toDate(v);
  if (!d) return '';
  return `${dateFmt.format(d).replace('/', '.')} ${timeFmt.format(d)}`;
}

/** Calendar day (YYYY-MM-DD) in Jerusalem, for "today" comparisons. */
export function jerusalemDay(v: string | number | Date): string {
  const d = toDate(v);
  return d ? dayKeyFmt.format(d) : '';
}

/** Whole minutes between two instants (never negative). */
export function minutesBetween(
  from: string | number | Date,
  to: number | Date = Date.now(),
): number {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000));
}

/** Compact duration as in the mockups: `0.4s`, `38s`, `1m 52s`, `11m`, `2h 5m`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 10) return rs ? `${m}m ${rs}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Seconds → compact duration. */
export const formatSeconds = (s: number | null | undefined) =>
  s === null || s === undefined ? '—' : formatDuration(s * 1000);

/** `mm:ss` countdown (never negative). */
export function formatCountdown(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Percentage with one decimal (`3.1%`), from a 0..1 rate. */
export function formatPct(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  const v = rate * 100;
  return `${v.toFixed(v === 0 || v === 100 ? 0 : digits)}%`;
}

/** Thousands separator, Latin digits (`1,284`). */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
