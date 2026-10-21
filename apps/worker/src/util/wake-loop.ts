/**
 * Serialised "run on wake-up or every N ms" loop. Realtime events call `wake()`; the interval is
 * the reconciliation fallback when Realtime drops (ADR-2, TEST-PLAN RL1). Never runs two passes
 * concurrently: a wake during a pass schedules exactly one more pass.
 */
export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realIntervals: IntervalTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface WakeLoopOptions {
  intervalMs: number;
  timers?: IntervalTimers;
  onError?: (err: unknown) => void;
}

export class WakeLoop {
  #timer: unknown = null;
  #running: Promise<void> | null = null;
  #again = false;
  #stopped = true;
  readonly #timers: IntervalTimers;

  constructor(
    private readonly pass: () => Promise<void>,
    private readonly opts: WakeLoopOptions,
  ) {
    this.#timers = opts.timers ?? realIntervals;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#timer = this.#timers.setInterval(() => void this.wake(), this.opts.intervalMs);
    void this.wake();
  }

  /** Run a pass now (or right after the current one). Resolves when that pass is done. */
  wake(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        try {
          await this.pass();
        } catch (err) {
          this.opts.onError?.(err);
        }
      } while (this.#again && !this.#stopped);
      this.#running = null;
    })();
    return this.#running;
  }

  /** Stop scheduling; waits for an in-flight pass. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  get running(): boolean {
    return this.#running !== null;
  }
}
