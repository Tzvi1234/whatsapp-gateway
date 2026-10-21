export const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** `YYYY-MM-DD` of the local calendar day in `timeZone`. */
export function localDayKey(at: Date | string | number, timeZone = DEFAULT_TIMEZONE): string {
  const p = localParts(new Date(at).getTime(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC instant of the most recent local midnight in `timeZone` (DST-safe). */
export function startOfLocalDay(at: Date | string | number, timeZone = DEFAULT_TIMEZONE): Date {
  const ms = new Date(at).getTime();
  const p = localParts(ms, timeZone);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  let guess = midnightAsUtc - offsetAt(midnightAsUtc, timeZone);
  guess = midnightAsUtc - offsetAt(guess, timeZone);
  return new Date(guess);
}

/** Count of timestamps that fall on the same local day as `now`. */
export function countOnLocalDay(
  timestamps: readonly (string | number | Date)[],
  now: Date | string | number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const key = localDayKey(now, timeZone);
  return timestamps.filter((t) => localDayKey(t, timeZone) === key).length;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
