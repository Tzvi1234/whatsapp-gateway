/**
 * pino destination that writes every line to stdout (journald) and batches lines at or above a
 * level into `worker_log` (ARCH §8.4, 7-day retention). Lines are already redacted by the
 * provider-baileys logger (REDACT_PATHS: content, QR, numbers, JIDs) before they reach this sink.
 * Shipping failures never throw and never log through pino (no feedback loop).
 */
import type { WorkerDb, WorkerLogEntry } from '../db/types';

const LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const LEVEL_NUM: Record<string, number> = Object.fromEntries(
  Object.entries(LEVELS).map(([n, l]) => [l, Number(n)]),
);

export interface LogShipperOptions {
  db: Pick<WorkerDb, 'workerLog'>;
  orgId: string;
  workerId: string;
  minLevel: string;
  /** stdout sink; default process.stdout. */
  out?: { write(s: string): unknown };
  maxBuffer?: number;
  batchSize?: number;
  maxDataBytes?: number;
}

export class LogShipper {
  readonly #o: LogShipperOptions;
  readonly #min: number;
  #buf: WorkerLogEntry[] = [];
  #flushing: Promise<boolean> | null = null;
  dropped = 0;

  constructor(o: LogShipperOptions) {
    this.#o = o;
    this.#min = LEVEL_NUM[o.minLevel] ?? 30;
  }

  /** pino DestinationStream. */
  write(line: string): void {
    (this.#o.out ?? process.stdout).write(line);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const lvl = typeof j.level === 'number' ? j.level : 30;
    if (lvl < this.#min) return;
    const { level: _l, time, event, correlation_id, ...rest } = j;
    let data: unknown = Object.keys(rest).length ? rest : null;
    const max = this.#o.maxDataBytes ?? 2_048;
    if (data !== null && JSON.stringify(data).length > max) data = { truncated: true };
    this.#buf.push({
      level: LEVELS[lvl] ?? 'info',
      msg: typeof event === 'string' ? event.slice(0, 200) : '',
      correlation_id: typeof correlation_id === 'string' ? correlation_id : null,
      data,
      at: typeof time === 'string' ? time : new Date().toISOString(),
    });
    const cap = this.#o.maxBuffer ?? 1_000;
    if (this.#buf.length > cap) {
      this.dropped += this.#buf.length - cap;
      this.#buf.splice(0, this.#buf.length - cap);
    }
    if (this.#buf.length >= (this.#o.batchSize ?? 100)) void this.flush();
  }

  get pending(): number {
    return this.#buf.length;
  }

  /** Ships one batch. Resolves false when the DB call failed (batch kept). */
  async flush(): Promise<boolean> {
    if (this.#flushing) return this.#flushing;
    if (this.#buf.length === 0) return true;
    const batch = this.#buf.splice(0, this.#o.batchSize ?? 100);
    const p = (async () => {
      try {
        await this.#o.db.workerLog(this.#o.orgId, this.#o.workerId, batch);
        return true;
      } catch {
        // Put them back; if the DB stays down the buffer cap drops the oldest.
        this.#buf.unshift(...batch);
        process.stderr.write('{"event":"worker_log_ship_failed"}\n');
        return false;
      }
    })();
    this.#flushing = p;
    void p.finally(() => {
      if (this.#flushing === p) this.#flushing = null;
    });
    return p;
  }
}
