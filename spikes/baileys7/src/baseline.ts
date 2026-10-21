/**
 * RL8 baseline from events.jsonl (pure; tested with synthetic events).
 * Feeds the "Spike results" section of docs/adr/0005-baileys-version.md.
 */
import type { SpikeEvent } from './events';

export interface Baseline {
  windowStart: string | null;
  windowEnd: string | null;
  observedHours: number;
  firstOpen: string | null;
  uptimePct: number | null;
  /** Auth-session lifetime: first open → first needs_relink (or end of data). */
  sessionLifetimeHours: number | null;
  sessionEndedBy: string | null;
  connectionIntervals: number;
  longestConnectionHours: number | null;
  medianConnectionHours: number | null;
  disconnectsByCode: Record<string, number>;
  /** Closes other than restartRequired (515) and deliberate stops. */
  unexplainedDisconnects: number;
  reconnectMs: { n: number; p50: number | null; p95: number | null; max: number | null };
  sendLatencyMs: { n: number; p50: number | null; p95: number | null };
  probeAckMs: { n: number; p50: number | null; p95: number | null };
  sends: number;
  sendFailures: number;
  failureRatePct: number | null;
  decryptFailures: number;
  inboundByType: Record<string, number>;
  needsRelink: number;
  conflicts: number;
  processStarts: number;
  restores: Array<{ ts: string; rePairNeeded: boolean; timeToOpenMs: number | null }>;
  /** First restore after a scheduled (36h) restart, if any (C14). */
  scheduledRestart: {
    ts: string;
    rePairNeeded: boolean | null;
    timeToOpenMs: number | null;
  } | null;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function parseEvents(jsonl: string): SpikeEvent[] {
  const out: SpikeEvent[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as SpikeEvent;
      if (typeof e.ts === 'string' && typeof e.type === 'string') out.push(e);
    } catch {
      /* skip torn last line after a crash */
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const HOUR = 3_600_000;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function computeBaseline(input: readonly SpikeEvent[]): Baseline {
  const events = [...input].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const t = (e: SpikeEvent) => Date.parse(e.ts);
  const start = events[0] ? t(events[0]) : null;
  const end = events.length ? t(events[events.length - 1]!) : null;

  const intervals: number[] = [];
  let openSince: number | null = null;
  let lastTs: number | null = null;
  let firstOpen: number | null = null;
  let sessionEnd: { at: number; by: string } | null = null;
  const disconnectsByCode: Record<string, number> = {};
  let unexplained = 0;
  const reconnect: number[] = [];
  const sendLatency: number[] = [];
  const probeAck: number[] = [];
  let sends = 0;
  let sendFailures = 0;
  let decrypt = 0;
  const inbound: Record<string, number> = {};
  let needsRelink = 0;
  let conflicts = 0;
  let processStarts = 0;
  const restores: Baseline['restores'] = [];
  let pendingScheduled: string | null = null;
  let scheduledRestart: Baseline['scheduledRestart'] = null;

  const closeInterval = (at: number) => {
    if (openSince !== null) {
      intervals.push(Math.max(0, at - openSince));
      openSince = null;
    }
  };

  for (const e of events) {
    const at = t(e);
    switch (e.type) {
      case 'process_start':
        processStarts++;
        // crashed without a close: the connection ended at the last thing we saw
        if (lastTs !== null) closeInterval(lastTs);
        break;
      case 'process_exit':
        closeInterval(at);
        break;
      case 'open':
        if (openSince === null) openSince = at;
        if (firstOpen === null) firstOpen = at;
        {
          const r = num(e.reconnect_ms);
          if (r !== null) reconnect.push(r);
        }
        break;
      case 'close': {
        closeInterval(at);
        const action = String(e.action ?? '');
        if (action === 'stopped') break;
        const code = e.code === null || e.code === undefined ? 'none' : String(e.code);
        disconnectsByCode[code] = (disconnectsByCode[code] ?? 0) + 1;
        if (action !== 'restart') unexplained++;
        break;
      }
      case 'needs_relink':
        needsRelink++;
        closeInterval(at);
        if (!sessionEnd && firstOpen !== null) sessionEnd = { at, by: `needs_relink:${e.code}` };
        break;
      case 'conflict':
        conflicts++;
        closeInterval(at);
        break;
      case 'send': {
        sends++;
        if (e.ok === true) {
          const l = num(e.latency_ms);
          if (l !== null) sendLatency.push(l);
        } else sendFailures++;
        break;
      }
      case 'probe_ack': {
        const a = num(e.ack_ms);
        if (a !== null && e.status === 'sent') probeAck.push(a);
        break;
      }
      case 'decrypt_failure':
        decrypt++;
        break;
      case 'inbound': {
        const k = String(e.msg_type ?? 'unknown');
        inbound[k] = (inbound[k] ?? 0) + 1;
        break;
      }
      case 'scheduled_restart':
        pendingScheduled = e.ts;
        break;
      case 'session_restored': {
        const r = {
          ts: e.ts,
          rePairNeeded: e.re_pair_needed === true,
          timeToOpenMs: num(e.time_to_open_ms),
        };
        restores.push(r);
        if (pendingScheduled && !scheduledRestart) {
          scheduledRestart = r;
          pendingScheduled = null;
        }
        break;
      }
    }
    lastTs = at;
  }
  if (end !== null) closeInterval(end);
  if (pendingScheduled && !scheduledRestart)
    scheduledRestart = { ts: pendingScheduled, rePairNeeded: null, timeToOpenMs: null };

  const openTotal = intervals.reduce((a, b) => a + b, 0);
  const uptimeWindow = firstOpen !== null && end !== null ? end - firstOpen : 0;
  const lifetimeEnd = sessionEnd?.at ?? end;

  return {
    windowStart: start !== null ? new Date(start).toISOString() : null,
    windowEnd: end !== null ? new Date(end).toISOString() : null,
    observedHours: start !== null && end !== null ? round((end - start) / HOUR) : 0,
    firstOpen: firstOpen !== null ? new Date(firstOpen).toISOString() : null,
    uptimePct: uptimeWindow > 0 ? round((100 * openTotal) / uptimeWindow) : null,
    sessionLifetimeHours:
      firstOpen !== null && lifetimeEnd !== null ? round((lifetimeEnd - firstOpen) / HOUR) : null,
    sessionEndedBy: sessionEnd?.by ?? null,
    connectionIntervals: intervals.length,
    longestConnectionHours: intervals.length ? round(Math.max(...intervals) / HOUR) : null,
    medianConnectionHours: intervals.length ? round(percentile(intervals, 50)! / HOUR) : null,
    disconnectsByCode,
    unexplainedDisconnects: unexplained,
    reconnectMs: {
      n: reconnect.length,
      p50: percentile(reconnect, 50),
      p95: percentile(reconnect, 95),
      max: reconnect.length ? Math.max(...reconnect) : null,
    },
    sendLatencyMs: {
      n: sendLatency.length,
      p50: percentile(sendLatency, 50),
      p95: percentile(sendLatency, 95),
    },
    probeAckMs: {
      n: probeAck.length,
      p50: percentile(probeAck, 50),
      p95: percentile(probeAck, 95),
    },
    sends,
    sendFailures,
    failureRatePct: sends ? round((100 * sendFailures) / sends) : null,
    decryptFailures: decrypt,
    inboundByType: inbound,
    needsRelink,
    conflicts,
    processStarts,
    restores,
    scheduledRestart,
  };
}

const fmt = (v: number | null | undefined, unit = '') =>
  v === null || v === undefined ? 'n/a' : `${v}${unit}`;

export function renderMarkdown(b: Baseline): string {
  const codes = Object.entries(b.disconnectsByCode)
    .sort(([a], [c]) => a.localeCompare(c))
    .map(([c, n]) => `${c}: ${n}`)
    .join(', ');
  const inbound = Object.entries(b.inboundByType)
    .sort(([a], [c]) => a.localeCompare(c))
    .map(([k, n]) => `${k}: ${n}`)
    .join(', ');
  const sr = b.scheduledRestart;
  const restart36h = sr
    ? sr.rePairNeeded === null
      ? `scheduled restart at ${sr.ts}, no session_restored logged after it`
      : `${sr.rePairNeeded ? '**re-pair NEEDED**' : 'no re-pair needed'}, time to open ${fmt(sr.timeToOpenMs, ' ms')}`
    : 'not observed';
  const rows: Array<[string, string]> = [
    ['Window', `${b.windowStart ?? 'n/a'} → ${b.windowEnd ?? 'n/a'} (${b.observedHours} h)`],
    ['Uptime (from first open)', fmt(b.uptimePct, ' %')],
    [
      'Session lifetime',
      `${fmt(b.sessionLifetimeHours, ' h')}${b.sessionEndedBy ? ` (ended by ${b.sessionEndedBy})` : ' (still valid)'}`,
    ],
    [
      'Connection intervals',
      `${b.connectionIntervals} (longest ${fmt(b.longestConnectionHours, ' h')}, median ${fmt(b.medianConnectionHours, ' h')})`,
    ],
    ['Disconnects by code', codes || 'none'],
    ['Unexplained disconnects (excl. 515/stop)', String(b.unexplainedDisconnects)],
    [
      'Reconnect time',
      `p50 ${fmt(b.reconnectMs.p50, ' ms')}, p95 ${fmt(b.reconnectMs.p95, ' ms')}, max ${fmt(b.reconnectMs.max, ' ms')} (n=${b.reconnectMs.n})`,
    ],
    [
      'Send latency (probe)',
      `p50 ${fmt(b.sendLatencyMs.p50, ' ms')}, p95 ${fmt(b.sendLatencyMs.p95, ' ms')} (n=${b.sendLatencyMs.n})`,
    ],
    [
      'Server ack (probe)',
      `p50 ${fmt(b.probeAckMs.p50, ' ms')}, p95 ${fmt(b.probeAckMs.p95, ' ms')} (n=${b.probeAckMs.n})`,
    ],
    ['Send failure rate', `${fmt(b.failureRatePct, ' %')} (${b.sendFailures}/${b.sends})`],
    ['Decrypt failures', String(b.decryptFailures)],
    ['Inbound by type', inbound || 'none'],
    ['needs_relink / conflict', `${b.needsRelink} / ${b.conflicts}`],
    ['Process starts', String(b.processStarts)],
    ['36h restart (C14)', restart36h],
    [
      'Restores',
      b.restores.length
        ? b.restores
            .map(
              (r) =>
                `${r.ts}: ${r.rePairNeeded ? 're-pair needed' : 'ok'} (${fmt(r.timeToOpenMs, ' ms')})`,
            )
            .join('; ')
        : 'none',
    ],
  ];
  const checks: Array<[string, boolean]> = [
    ['≥72h observed', b.observedHours >= 72],
    ['No unexplained disconnects', b.unexplainedDisconnects === 0],
    ['No decrypt failures', b.decryptFailures === 0],
    [
      'No re-pair after restart',
      b.restores.every((r) => !r.rePairNeeded) && sr?.rePairNeeded !== true,
    ],
    ['No needs_relink / conflict', b.needsRelink === 0 && b.conflicts === 0],
  ];
  return [
    '### Baileys 7 spike baseline (RL8)',
    '',
    '| Metric | Value |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '**Automatic go/no-go hints (ADR-5; manual checks for QR, media, voice and groups still apply):**',
    '',
    ...checks.map(([k, ok]) => `- [${ok ? 'x' : ' '}] ${k}`),
    '',
  ].join('\n');
}
