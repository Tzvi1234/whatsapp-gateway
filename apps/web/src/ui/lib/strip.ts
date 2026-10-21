/**
 * 24-hour connection strip (number.html): one slot per hour, oldest on the left (the strip is
 * `direction: ltr`). Built from `session_events` + failed sends. Pure.
 *   ok = connected the whole hour · w = a short drop that recovered, or failed sends · c = down
 *   at the end of the hour · n = no data (never connected yet).
 */
export type Slot = 'ok' | 'w' | 'c' | 'n';

const UP = new Set(['open', 'paired', 'relinked', 'restored']);
const DOWN = new Set(['close', 'needs_relink', 'conflict', 'logged_out']);
const DOWN_STATUS = new Set(['closed', 'needs_relink', 'conflict', 'paused']);

type State = 'up' | 'down' | 'none';

export interface StripView {
  slots: Slot[];
  /** Position (0-100, from the left) where the current outage started, if inside the window. */
  onsetPct: number | null;
  /** ISO time the current outage started, if known. */
  downSince: string | null;
  /** Axis labels: 24h ago, -18h, -12h, -6h (ISO), then "now". */
  ticks: string[];
}

const HOUR = 3_600_000;

export function buildHourStrip(
  events: { event: string; at: string }[],
  failedAt: string[],
  status: string,
  now: number = Date.now(),
): StripView {
  const start = now - 24 * HOUR;
  const evs = events
    .map((e) => ({
      kind: UP.has(e.event) ? 'up' : DOWN.has(e.event) ? 'down' : null,
      t: Date.parse(e.at),
      at: e.at,
    }))
    .filter(
      (e): e is { kind: 'up' | 'down'; t: number; at: string } =>
        e.kind !== null && Number.isFinite(e.t),
    )
    .sort((a, b) => a.t - b.t);

  const before = evs.filter((e) => e.t < start);
  const inside = evs.filter((e) => e.t >= start && e.t <= now);
  let state: State;
  const lastBefore = before[before.length - 1];
  const firstInside = inside[0];
  if (lastBefore) state = lastBefore.kind;
  else if (firstInside) state = firstInside.kind === 'down' ? 'up' : 'down';
  else if (status === 'open') state = 'up';
  else if (DOWN_STATUS.has(status)) state = 'down';
  else state = 'none';

  const fails = failedAt.map((x) => Date.parse(x)).filter((t) => Number.isFinite(t) && t >= start);
  const slots: Slot[] = [];
  let i = 0;
  for (let h = 0; h < 24; h++) {
    const s0 = start + h * HOUR;
    const s1 = s0 + HOUR;
    let wasDown = state === 'down';
    let anyUp = state === 'up';
    while (i < inside.length && inside[i]!.t < s1) {
      state = inside[i]!.kind;
      if (state === 'down') wasDown = true;
      else anyUp = true;
      i++;
    }
    const failed = fails.some((t) => t >= s0 && t < s1);
    if (state === 'none' && !anyUp && !wasDown) slots.push('n');
    else if (state === 'down') slots.push('c');
    else if (wasDown || failed) slots.push('w');
    else slots.push('ok');
  }

  let onsetPct: number | null = null;
  let downSince: string | null = null;
  if (DOWN_STATUS.has(status) || state === 'down') {
    const lastUpIdx = evs.map((e) => e.kind).lastIndexOf('up');
    const onset = evs.slice(lastUpIdx + 1).find((e) => e.kind === 'down');
    if (onset) {
      downSince = onset.at;
      if (onset.t >= start) onsetPct = Math.round(((onset.t - start) / (24 * HOUR)) * 1000) / 10;
    }
  }
  const ticks = [0, 6, 12, 18].map((h) => new Date(start + h * HOUR).toISOString());
  return { slots, onsetPct, downSince, ticks };
}
