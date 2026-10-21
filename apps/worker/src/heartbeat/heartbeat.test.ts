import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@htz/provider-baileys';
import { FakeDb, ORG, silentLogger } from '../test/fakes';
import { createHeartbeat } from './heartbeat';
import { LogShipper } from './log-shipper';

afterEach(() => vi.useRealTimers());

describe('heartbeat', () => {
  it('RL5 records a heartbeat every 60 s with per-socket state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const db = new FakeDb();
    const hb = createHeartbeat({
      db,
      orgId: ORG,
      workerId: 'w1',
      version: '0.1.0',
      baileysVersion: '7.0.0-rc14',
      sockets: () => [{ account_id: 'a1', connection: 'open' }],
      log: silentLogger(),
    });
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    const calls = db.callsOf('recordHeartbeat');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      ORG,
      'w1',
      '0.1.0',
      '7.0.0-rc14',
      [{ account_id: 'a1', connection: 'open' }],
    ]);
    await hb.stop();
  });

  it('a failing heartbeat never throws', async () => {
    const db = new FakeDb();
    db.recordHeartbeat = async () => {
      throw new Error('down');
    };
    const hb = createHeartbeat({
      db,
      orgId: ORG,
      workerId: 'w1',
      version: 'v',
      baileysVersion: 'b',
      sockets: () => [],
      log: silentLogger(),
    });
    await expect(hb.beat()).resolves.toBeUndefined();
  });
});

describe('worker_log shipping', () => {
  it('ships redacted lines at or above the level in batches; content/numbers never shipped', async () => {
    const db = new FakeDb();
    const out: string[] = [];
    const shipper = new LogShipper({
      db,
      orgId: ORG,
      workerId: 'w1',
      minLevel: 'info',
      out: { write: (s: string) => out.push(s) },
      batchSize: 2,
    });
    const log = createLogger({ level: 'debug', destination: shipper });
    log.debug({}, 'noise');
    log.info({ correlation_id: 'msg-1', text: 'secret body', to: '+972559014410' }, 'job_sent');
    log.warn({ code: 'x' }, 'job_failed');
    await shipper.flush();
    expect(out).toHaveLength(3); // everything still goes to stdout/journal
    const entries = db.callsOf('workerLog').flatMap((c) => c[2] as Array<Record<string, unknown>>);
    expect(entries.map((e) => e.msg)).toEqual(['job_sent', 'job_failed']);
    expect(entries[0]).toMatchObject({ level: 'info', correlation_id: 'msg-1' });
    const shipped = JSON.stringify(entries);
    expect(shipped).not.toContain('secret body');
    expect(shipped).not.toContain('972559014410');
  });

  it('keeps the batch when the DB is down and caps the buffer', async () => {
    const db = new FakeDb();
    db.workerLog = async () => {
      throw new Error('down');
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const shipper = new LogShipper({
      db,
      orgId: ORG,
      workerId: 'w1',
      minLevel: 'info',
      out: { write: () => true },
      maxBuffer: 3,
      batchSize: 100,
    });
    for (let i = 0; i < 5; i++)
      shipper.write(JSON.stringify({ level: 30, event: `e${i}`, time: new Date().toISOString() }));
    await shipper.flush();
    expect(shipper.pending).toBe(3);
    expect(shipper.dropped).toBe(2);
    stderr.mockRestore();
  });
});
