/**
 * Ban-risk pacing (ARCH §7.8): per-account token bucket (default ≤20 msgs/min), ≤1 msg per 3s
 * per chat, rolling 24h daily cap, plus 1–10s jitter; and a circuit breaker that pauses an
 * account on `forbidden`/`connectionReplaced` or a failure spike. Pure: clock and RNG injected.
 */

export interface PacingConfig {
  perMinute: number;
  perChatIntervalMs: number;
  dailyCap: number;
  jitterMinMs: number;
  jitterMaxMs: number;
}

export const DEFAULT_PACING: PacingConfig = {
  perMinute: 20,
  perChatIntervalMs: 3_000,
  dailyCap: 500,
  jitterMinMs: 1_000,
  jitterMaxMs: 10_000,
};

export interface PacingDeps {
  now?: (() => number) | undefined;
  /** [0,1) */
  random?: (() => number) | undefined;
}

export type PaceDecision =
  { ok: true; waitMs: number } | { ok: false; reason: 'daily_cap'; retryAfterMs: number };

const DAY_MS = 24 * 60 * 60 * 1000;

interface AccountPace {
  tokens: number;
  updatedAt: number;
  chatNextAt: Map<string, number>;
  sentAt: number[];
}

export class Pacer {
  readonly config: PacingConfig;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #accounts = new Map<string, AccountPace>();

  constructor(config: Partial<PacingConfig> = {}, deps: PacingDeps = {}) {
    this.config = { ...DEFAULT_PACING, ...config };
    const c = this.config;
    if (c.perMinute <= 0 || c.dailyCap <= 0 || c.perChatIntervalMs < 0)
      throw new Error('invalid pacing config');
    if (c.jitterMinMs < 0 || c.jitterMaxMs < c.jitterMinMs) throw new Error('invalid jitter');
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
  }

  #state(accountId: string, now: number): AccountPace {
    let s = this.#accounts.get(accountId);
    if (!s) {
      s = { tokens: this.config.perMinute, updatedAt: now, chatNextAt: new Map(), sentAt: [] };
      this.#accounts.set(accountId, s);
    }
    return s;
  }

  jitterMs(): number {
    const { jitterMinMs: lo, jitterMaxMs: hi } = this.config;
    return Math.floor(lo + this.#random() * (hi - lo));
  }

  /**
   * Reserves a send slot for (account, chat). Returns how long to wait (including jitter) before
   * sending, or `daily_cap` with when to retry. A reservation is consumed immediately.
   */
  reserve(accountId: string, chat: string): PaceDecision {
    const now = this.#now();
    const c = this.config;
    const s = this.#state(accountId, now);

    // rolling 24h cap
    while (s.sentAt.length && s.sentAt[0]! <= now - DAY_MS) s.sentAt.shift();
    if (s.sentAt.length >= c.dailyCap) {
      return { ok: false, reason: 'daily_cap', retryAfterMs: s.sentAt[0]! + DAY_MS - now };
    }

    // token bucket (may go negative = queued reservations)
    const ratePerMs = c.perMinute / 60_000;
    s.tokens = Math.min(c.perMinute, s.tokens + (now - s.updatedAt) * ratePerMs);
    s.updatedAt = now;
    s.tokens -= 1;
    const bucketWait = s.tokens >= 0 ? 0 : Math.ceil(-s.tokens / ratePerMs);

    // per-chat spacing
    const chatWait = Math.max(0, (s.chatNextAt.get(chat) ?? 0) - now);

    const waitMs = Math.max(bucketWait, chatWait) + this.jitterMs();
    s.chatNextAt.set(chat, now + waitMs + c.perChatIntervalMs);
    s.sentAt.push(now + waitMs);
    if (s.chatNextAt.size > 5_000) {
      for (const [k, v] of s.chatNextAt) if (v < now) s.chatNextAt.delete(k);
    }
    return { ok: true, waitMs };
  }

  /** Sends in the last 24h (incl. reserved). */
  usedToday(accountId: string): number {
    const now = this.#now();
    return this.#accounts.get(accountId)?.sentAt.filter((t) => t > now - DAY_MS).length ?? 0;
  }
}

// ---------------------------------------------------------------------------------------------

export type BreakerTripReason = 'forbidden' | 'connection_replaced' | 'failure_spike';

export interface CircuitBreakerConfig {
  /** Failures within `windowMs` that trip the breaker. */
  failureThreshold: number;
  windowMs: number;
  /** How long a failure-spike trip lasts. Ban signals never auto-close. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 5 * 60_000,
  cooldownMs: 30 * 60_000,
};

export type BreakerState =
  { open: false } | { open: true; reason: BreakerTripReason; since: number; until: number | null };

/** One per account. `forbidden` / `connection_replaced` stay open until `reset()` (manual). */
export class CircuitBreaker {
  readonly config: CircuitBreakerConfig;
  readonly #now: () => number;
  #failures: number[] = [];
  #state: BreakerState = { open: false };

  constructor(
    config: Partial<CircuitBreakerConfig> = {},
    deps: { now?: (() => number) | undefined } = {},
  ) {
    this.config = { ...DEFAULT_BREAKER, ...config };
    this.#now = deps.now ?? Date.now;
  }

  state(): BreakerState {
    const s = this.#state;
    if (s.open && s.until !== null && this.#now() >= s.until) {
      this.#state = { open: false };
      this.#failures = [];
    }
    return this.#state;
  }

  isOpen(): boolean {
    return this.state().open;
  }

  trip(reason: BreakerTripReason): void {
    const now = this.#now();
    const until = reason === 'failure_spike' ? now + this.config.cooldownMs : null;
    this.#state = { open: true, reason, since: now, until };
  }

  recordSuccess(): void {
    this.#failures = [];
  }

  /** Returns true when this failure tripped the breaker. */
  recordFailure(): boolean {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => t > now - this.config.windowMs);
    this.#failures.push(now);
    if (!this.isOpen() && this.#failures.length >= this.config.failureThreshold) {
      this.trip('failure_spike');
      return true;
    }
    return false;
  }

  reset(): void {
    this.#state = { open: false };
    this.#failures = [];
  }
}
