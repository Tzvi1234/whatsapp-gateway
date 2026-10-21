/**
 * Queue wiring: Realtime INSERT on `outbound_queue` is only a wake-up signal; the WakeLoop polls
 * `claim_jobs` every 30-60 s regardless (ADR-2, RL1). `wake()` is also called locally right after
 * the worker enqueues its own replies.
 */
import type { ChangeFeed } from '../db/realtime';
import { WakeLoop, type IntervalTimers } from '../util/wake-loop';
import type { QueueProcessor } from './processor';

export interface QueueRunner {
  start(): void;
  wake(): Promise<void>;
  /** Stop claiming (SIGTERM); waits for the in-flight job. */
  stop(): Promise<void>;
}

export function createQueueRunner(opts: {
  processor: QueueProcessor;
  feed: ChangeFeed;
  pollIntervalMs: number;
  timers?: IntervalTimers;
  onError?: (err: unknown) => void;
}): QueueRunner {
  const loop = new WakeLoop(
    async () => {
      await opts.processor.runOnce();
    },
    {
      intervalMs: opts.pollIntervalMs,
      ...(opts.timers ? { timers: opts.timers } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    },
  );
  let unsubscribe: (() => Promise<void>) | null = null;
  return {
    start() {
      unsubscribe = opts.feed.onInsert('outbound_queue', () => void loop.wake());
      loop.start();
    },
    wake: () => loop.wake(),
    async stop() {
      opts.processor.stop();
      await unsubscribe?.().catch(() => undefined);
      await loop.stop();
    },
  };
}
