import { describe, expect, it } from 'vitest';
import { CircuitBreaker, Pacer } from './pacing';
import { classifyDisconnect, disconnectCode, reconnectDelayMs } from './disconnect';

const CHAT = '972500000001@s.whatsapp.net';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('Pacer (ARCH §7.8)', () => {
  it('jitter stays within 1–10s', () => {
    const lo = new Pacer({}, { random: () => 0 }).jitterMs();
    const hi = new Pacer({}, { random: () => 0.999999 }).jitterMs();
    expect(lo).toBe(1_000);
    expect(hi).toBeLessThan(10_000);
    expect(hi).toBeGreaterThanOrEqual(9_999);
  });

  it('≤20 msgs/min per account: the 21st send waits for a token', () => {
    const c = clock();
    const p = new Pacer({ jitterMinMs: 0, jitterMaxMs: 0, perChatIntervalMs: 0 }, { now: c.now });
    for (let i = 0; i < 20; i++) {
      const d = p.reserve('acc', `chat-${i}`);
      expect(d).toEqual({ ok: true, waitMs: 0 });
    }
    const d = p.reserve('acc', 'chat-x');
    expect(d.ok && d.waitMs).toBe(3_000); // 60s / 20
    // other accounts are independent
    expect(p.reserve('acc-2', 'chat-x')).toEqual({ ok: true, waitMs: 0 });
  });

  it('≤1 msg / 3s per chat', () => {
    const c = clock();
    const p = new Pacer({ jitterMinMs: 0, jitterMaxMs: 0 }, { now: c.now });
    expect(p.reserve('acc', CHAT)).toEqual({ ok: true, waitMs: 0 });
    const second = p.reserve('acc', CHAT);
    expect(second.ok && second.waitMs).toBe(3_000);
    c.advance(10_000);
    expect(p.reserve('acc', CHAT)).toEqual({ ok: true, waitMs: 0 });
  });

  it('jitter is added on top of the wait and pushes the chat window', () => {
    const c = clock();
    const p = new Pacer(
      { jitterMinMs: 1_000, jitterMaxMs: 10_000 },
      { now: c.now, random: () => 0.5 },
    );
    const a = p.reserve('acc', CHAT);
    expect(a.ok && a.waitMs).toBe(5_500);
    const b = p.reserve('acc', CHAT);
    expect(b.ok && b.waitMs).toBe(5_500 + 3_000 + 5_500);
  });

  it('daily cap (rolling 24h) returns daily_cap with retryAfter', () => {
    const c = clock();
    const p = new Pacer(
      { dailyCap: 3, jitterMinMs: 0, jitterMaxMs: 0, perChatIntervalMs: 0, perMinute: 1000 },
      { now: c.now },
    );
    for (let i = 0; i < 3; i++) expect(p.reserve('acc', `c${i}`).ok).toBe(true);
    const d = p.reserve('acc', 'c4');
    expect(d).toEqual({ ok: false, reason: 'daily_cap', retryAfterMs: 24 * 3600_000 });
    c.advance(24 * 3600_000 + 1);
    expect(p.reserve('acc', 'c4').ok).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  it('ban signals stay open until manual reset', () => {
    const c = clock();
    const b = new CircuitBreaker({}, { now: c.now });
    b.trip('forbidden');
    c.advance(10 * 24 * 3600_000);
    expect(b.state()).toMatchObject({ open: true, reason: 'forbidden', until: null });
    b.reset();
    expect(b.isOpen()).toBe(false);
  });

  it('a failure spike trips for the cooldown, then closes', () => {
    const c = clock();
    const b = new CircuitBreaker(
      { failureThreshold: 3, windowMs: 60_000, cooldownMs: 600_000 },
      { now: c.now },
    );
    expect(b.recordFailure()).toBe(false);
    expect(b.recordFailure()).toBe(false);
    expect(b.recordFailure()).toBe(true);
    expect(b.state()).toMatchObject({ open: true, reason: 'failure_spike' });
    c.advance(600_000);
    expect(b.isOpen()).toBe(false);
  });

  it('failures outside the window do not accumulate; success resets', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000 }, { now: c.now });
    b.recordFailure();
    b.recordFailure();
    c.advance(61_000);
    expect(b.recordFailure()).toBe(false);
    b.recordSuccess();
    b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });
});

describe('RL4 disconnect policy', () => {
  it.each([
    [515, 'restart'],
    [401, 'needs_relink'],
    [500, 'needs_relink'],
    [411, 'needs_relink'],
    [440, 'conflict'],
    [403, 'conflict'],
    [428, 'reconnect'],
    [408, 'reconnect'],
    [503, 'reconnect'],
    [undefined, 'reconnect'],
  ] as const)('code %s → %s', (code, action) => {
    expect(classifyDisconnect(code)).toBe(action);
  });

  it('backoff 1s→30s cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((a) => reconnectDelayMs(a))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('reads Boom output.statusCode', () => {
    expect(disconnectCode({ output: { statusCode: 440 } })).toBe(440);
    expect(disconnectCode(new Error('x'))).toBeUndefined();
  });
});
