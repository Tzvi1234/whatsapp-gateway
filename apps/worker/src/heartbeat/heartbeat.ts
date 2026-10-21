/**
 * Worker heartbeat (ARCH §8.3, TEST-PLAN RL5): `record_heartbeat` every 60 s with per-socket
 * state. Server-down detection itself runs in Supabase (pg_cron → heartbeat-alert), so the only
 * job here is to keep beating while the process is healthy.
 */
import type { Logger } from 'pino';
import type { WorkerDb } from '../db/types';
import { WakeLoop, type IntervalTimers } from '../util/wake-loop';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface HeartbeatDeps {
  db: Pick<WorkerDb, 'recordHeartbeat'>;
  orgId: string;
  workerId: string;
  version: string;
  baileysVersion: string;
  sockets: () => unknown[];
  log: Logger;
  intervalMs?: number;
  timers?: IntervalTimers;
}

export function createHeartbeat(d: HeartbeatDeps): {
  start(): void;
  stop(): Promise<void>;
  beat(): Promise<void>;
} {
  let failures = 0;
  const beat = async () => {
    try {
      await d.db.recordHeartbeat(d.orgId, d.workerId, d.version, d.baileysVersion, d.sockets());
      if (failures > 0) d.log.info({ after: failures }, 'heartbeat_recovered');
      failures = 0;
    } catch (err) {
      failures += 1;
      d.log.warn({ failures, err: (err as Error).name }, 'heartbeat_failed');
    }
  };
  const loop = new WakeLoop(beat, {
    intervalMs: d.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    ...(d.timers ? { timers: d.timers } : {}),
  });
  return { start: () => loop.start(), stop: () => loop.stop(), beat };
}
