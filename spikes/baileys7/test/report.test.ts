// RL8 baseline aggregation from synthetic events (no real data, no content).
import { describe, expect, it } from 'vitest';
import { computeBaseline, parseEvents, percentile, renderMarkdown } from '../src/baseline';
import type { SpikeEvent } from '../src/events';

const T0 = Date.parse('2026-10-22T00:00:00.000Z');
const H = 3_600_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const ev = (ms: number, type: string, extra: Record<string, unknown> = {}): SpikeEvent => ({
  ts: at(ms),
  type,
  ...extra,
});

function run72h(): SpikeEvent[] {
  return [
    ev(0, 'process_start'),
    ev(1_000, 'pairing_code_issued'),
    ev(60_000, 'paired'),
    ev(60_000, 'open', { is_new_login: true, reconnect_ms: null }),
    ev(10 * H, 'close', { code: 428, action: 'reconnect' }),
    ev(10 * H + 2_000, 'open', { reconnect_ms: 2_000 }),
    ev(20 * H, 'close', { code: 515, action: 'restart' }),
    ev(20 * H + 500, 'open', { reconnect_ms: 500 }),
    ev(25 * H, 'send', { kind: 'probe', ok: true, latency_ms: 300 }),
    ev(25 * H + 1, 'probe_ack', { status: 'sent', ack_ms: 350 }),
    ev(26 * H, 'send', { kind: 'probe', ok: true, latency_ms: 500 }),
    ev(27 * H, 'send', { kind: 'probe', ok: false, latency_ms: 10_000, error: 'Error' }),
    ev(28 * H, 'decrypt_failure', { chat_kind: 'lid' }),
    ev(29 * H, 'inbound', { msg_type: 'voice' }),
    ev(29 * H + 1, 'inbound', { msg_type: 'text' }),
    ev(29 * H + 2, 'inbound', { msg_type: 'text' }),
    // 36h scheduled restart
    ev(36 * H, 'scheduled_restart'),
    ev(36 * H + 10, 'close', { code: null, action: 'stopped' }),
    ev(36 * H + 20, 'process_exit', { exit_code: 0, reason: 'SIGTERM' }),
    ev(36 * H + 5_000, 'process_start'),
    ev(36 * H + 8_000, 'open', { restored: true, reconnect_ms: null }),
    ev(36 * H + 8_001, 'session_restored', { re_pair_needed: false, time_to_open_ms: 3_000 }),
    // crash without close: last heartbeat bounds the interval
    ev(50 * H, 'heartbeat', { state: 'open' }),
    ev(50 * H + 30_000, 'process_start'),
    ev(50 * H + 34_000, 'open', { reconnect_ms: null }),
    ev(50 * H + 34_001, 'session_restored', { re_pair_needed: false, time_to_open_ms: 4_000 }),
    ev(72 * H + 60_000, 'heartbeat', { state: 'open' }),
  ];
}

describe('RL8 computeBaseline', () => {
  const b = computeBaseline(run72h());

  it('window, uptime and connection intervals', () => {
    expect(b.observedHours).toBeCloseTo(72.02, 2);
    expect(b.firstOpen).toBe(at(60_000));
    expect(b.connectionIntervals).toBe(5);
    // downtime: 2s + 0.5s + (stop→reopen ~8s) + (crash gap 34s) over 72h
    expect(b.uptimePct).toBeGreaterThan(99.9);
    expect(b.uptimePct).toBeLessThan(100);
    expect(b.longestConnectionHours).toBeCloseTo(22.02, 1);
  });

  it('session lifetime still valid', () => {
    expect(b.sessionLifetimeHours).toBeCloseTo(72, 1);
    expect(b.sessionEndedBy).toBeNull();
  });

  it('disconnects by code, excluding deliberate stops; 515 not unexplained', () => {
    expect(b.disconnectsByCode).toEqual({ '428': 1, '515': 1 });
    expect(b.unexplainedDisconnects).toBe(1);
  });

  it('reconnect / send latency percentiles and failure rate', () => {
    expect(b.reconnectMs).toEqual({ n: 2, p50: 500, p95: 2_000, max: 2_000 });
    expect(b.sendLatencyMs).toEqual({ n: 2, p50: 300, p95: 500 });
    expect(b.probeAckMs).toEqual({ n: 1, p50: 350, p95: 350 });
    expect(b.sends).toBe(3);
    expect(b.sendFailures).toBe(1);
    expect(b.failureRatePct).toBeCloseTo(33.33, 2);
  });

  it('decrypt failures, inbound types, restarts', () => {
    expect(b.decryptFailures).toBe(1);
    expect(b.inboundByType).toEqual({ voice: 1, text: 2 });
    expect(b.processStarts).toBe(3);
    expect(b.restores).toHaveLength(2);
    expect(b.scheduledRestart).toEqual({
      ts: at(36 * H + 8_001),
      rePairNeeded: false,
      timeToOpenMs: 3_000,
    });
  });

  it('C14 reports a re-pair after the scheduled restart', () => {
    const r = computeBaseline([
      ev(0, 'process_start'),
      ev(1, 'open'),
      ev(36 * H, 'scheduled_restart'),
      ev(36 * H + 1, 'process_start'),
      ev(36 * H + 2, 'close', { code: 401, action: 'needs_relink' }),
      ev(36 * H + 3, 'needs_relink', { code: 401 }),
      ev(36 * H + 4, 'session_restored', { re_pair_needed: true, time_to_open_ms: null }),
    ]);
    expect(r.scheduledRestart?.rePairNeeded).toBe(true);
    expect(r.sessionEndedBy).toBe('needs_relink:401');
    expect(r.needsRelink).toBe(1);
    const md = renderMarkdown(r);
    expect(md).toContain('re-pair NEEDED');
    expect(md).toContain('- [ ] No re-pair after restart');
  });

  it('renders markdown for the ADR', () => {
    const md = renderMarkdown(b);
    expect(md).toContain('| Uptime (from first open) |');
    expect(md).toContain('428: 1, 515: 1');
    expect(md).toContain('- [x] ≥72h observed');
    expect(md).toContain('- [ ] No decrypt failures');
    expect(md).toContain('no re-pair needed, time to open 3000 ms');
  });

  it('handles empty input and torn lines', () => {
    expect(computeBaseline([])).toMatchObject({
      observedHours: 0,
      uptimePct: null,
      firstOpen: null,
    });
    const parsed = parseEvents(
      `${JSON.stringify(ev(0, 'open'))}\n{"ts":"2026-10-22T00:00:01Z","ty`,
    );
    expect(parsed).toHaveLength(1);
    expect(renderMarkdown(computeBaseline(parsed))).toContain('Baileys 7 spike baseline');
  });

  it('percentile is nearest-rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});
