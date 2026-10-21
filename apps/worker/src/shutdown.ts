/**
 * Graceful shutdown (SIGTERM from systemd): stop claiming jobs → let the in-flight job finish →
 * close sockets WITHOUT logout (session restorable) → release account locks → final heartbeat/log
 * flush. Each step is bounded; a hung step never blocks the next one.
 */
import type { Logger } from 'pino';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
  /** Default 10 s. */
  timeoutMs?: number;
}

export function createShutdown(steps: readonly ShutdownStep[], log: Pick<Logger, 'info' | 'warn'>) {
  let done: Promise<void> | null = null;
  return (reason: string): Promise<void> => {
    if (done) return done;
    done = (async () => {
      log.info({ reason }, 'shutdown_start');
      for (const s of steps) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), s.timeoutMs ?? 10_000);
        });
        try {
          const r = await Promise.race([s.run().then(() => 'ok' as const), timeout]);
          if (r === 'timeout') log.warn({ step: s.name }, 'shutdown_step_timeout');
        } catch (err) {
          log.warn({ step: s.name, err: (err as Error).name }, 'shutdown_step_failed');
        } finally {
          clearTimeout(timer);
        }
      }
      log.info({ reason }, 'shutdown_done');
    })();
    return done;
  };
}
