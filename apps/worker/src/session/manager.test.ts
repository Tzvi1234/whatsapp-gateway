import { describe, expect, it, vi } from 'vitest';
import type { ProviderSession } from '@htz/provider-baileys';
import {
  ACC,
  FakeDb,
  FakeSession,
  ORG,
  TZVI_PN,
  captureLogger,
  flush,
  relayAccount,
} from '../test/fakes';
import { SessionManager } from './manager';

function setup(opts: { lock?: boolean | (() => boolean) } = {}) {
  const db = new FakeDb();
  db.accounts.set(ACC, relayAccount({ status: 'open' }));
  if (opts.lock !== undefined) db.lockResult = opts.lock;
  const sessions: FakeSession[] = [];
  const registered = new Map<string, ProviderSession>();
  const { log, lines } = captureLogger();
  const onMessage = vi.fn();
  const mgr = new SessionManager({
    orgId: ORG,
    workerId: 'w1',
    db,
    createSession: (accountId) => {
      const s = new FakeSession(accountId);
      sessions.push(s);
      return s;
    },
    provider: {
      register: (s) => registered.set(s.accountId, s),
      unregister: (id) => registered.delete(id),
    },
    onMessage,
    log,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  });
  return { db, mgr, sessions, registered, lines, onMessage };
}

describe('SessionManager', () => {
  it('S5 a second worker that cannot take the lease never opens the session', async () => {
    const t = setup({ lock: false });
    await t.mgr.start();
    expect(t.sessions).toHaveLength(0);
    expect(t.registered.size).toBe(0);
  });

  it('S5 lease lost on renewal → socket closed immediately and unregistered', async () => {
    let allow = true;
    const t = setup({ lock: () => allow });
    await t.mgr.start();
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]!.callsOf('start')).toHaveLength(1);
    allow = false;
    await t.mgr.renewLocks();
    expect(t.sessions[0]!.callsOf('close')).toHaveLength(1);
    expect(t.sessions[0]!.callsOf('logout')).toHaveLength(0);
    expect(t.registered.size).toBe(0);
    expect(t.mgr.session(ACC)).toBeNull();
    expect(t.sessions[0]!.listenerCount).toBe(0);
  });

  it('renews the lease with the configured TTL while held', async () => {
    const t = setup();
    await t.mgr.start();
    await t.mgr.renewLocks();
    const calls = t.db.callsOf('tryLockAccount');
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual([ACC, 'w1', 90]);
  });

  it('only previously paired accounts autostart', async () => {
    const t = setup();
    t.db.accounts.set(ACC, relayAccount({ status: 'needs_relink' }));
    await t.mgr.start();
    expect(t.sessions).toHaveLength(0);
  });

  it('pairing: QR goes only to worker_pairing_qr_upsert (never logged); open → pairing_finish with E.164', async () => {
    const t = setup();
    t.db.accounts.set(ACC, relayAccount({ status: 'unconfigured' }));
    await t.mgr.start();
    const req = {
      id: 'req-1',
      account_id: ACC,
      method: 'qr' as const,
      phone_e164: null,
      state: 'pending',
      expires_at: new Date(Date.now() + 180_000).toISOString(),
    };
    t.db.pairing.push(req);
    await t.mgr.syncCommands();
    const s = t.sessions[0]!;
    const QR = '2@SECRET-QR-PAYLOAD,abc';
    s.emit({ type: 'qr', qr: QR });
    await flush();
    expect(t.db.callsOf('pairingQrUpsert')[0]).toEqual(['req-1', 'w1', { qr: QR }]);
    s.state = 'open';
    s.emit({
      type: 'open',
      me: { pn: TZVI_PN, lid: null },
      isNewLogin: true,
      restored: false,
      sinceStartMs: 1,
      reconnectMs: null,
    });
    await flush();
    expect(t.db.callsOf('pairingFinish')[0]).toEqual(['req-1', 'w1', 'paired', '+972559014410']);
    expect(t.lines.join('\n')).not.toContain('SECRET-QR-PAYLOAD');
    // handled once even if polled again
    await t.mgr.syncCommands();
    expect(t.sessions).toHaveLength(1);
  });

  it('session events are persisted through worker_session_event; needs_relink releases the account', async () => {
    const t = setup();
    await t.mgr.start();
    const s = t.sessions[0]!;
    s.emit({ type: 'close', code: 401, action: 'needs_relink', reconnectInMs: null });
    s.emit({ type: 'needs_relink', code: 401, reason: 'logged_out' });
    await flush();
    await flush();
    const events = t.db.callsOf('sessionEvent').map((c) => c[2]);
    expect(events).toEqual(['close', 'logged_out']);
    expect(t.db.callsOf('unlockAccount')).toHaveLength(1);
  });

  it('commands: reconnect restarts the socket; logout logs out and unlocks', async () => {
    const t = setup();
    await t.mgr.start();
    await t.mgr.handleCommand({
      id: 'c1',
      account_id: ACC,
      command: 'reconnect',
      state: 'pending',
      created_at: '',
    });
    expect(t.sessions).toHaveLength(2);
    expect(t.sessions[0]!.callsOf('close')).toHaveLength(1);
    expect(t.db.callsOf('completeSessionCommand')[0]).toEqual(['c1', 'done', 'restarted']);
    await t.mgr.handleCommand({
      id: 'c2',
      account_id: ACC,
      command: 'logout',
      state: 'pending',
      created_at: '',
    });
    expect(t.sessions[1]!.callsOf('logout')).toHaveLength(1);
    expect(t.db.callsOf('completeSessionCommand')[1]).toEqual(['c2', 'done', 'logged_out']);
  });

  it('graceful stop closes sockets without logout and releases locks', async () => {
    const t = setup();
    await t.mgr.start();
    await t.mgr.stop();
    expect(t.sessions[0]!.callsOf('close')).toHaveLength(1);
    expect(t.sessions[0]!.callsOf('logout')).toHaveLength(0);
    expect(t.db.callsOf('unlockAccount')).toEqual([[ACC, 'w1']]);
    expect(t.db.callsOf('sessionEvent').map((c) => c[2])).toContain('close');
  });

  it('inbound messages and delivery receipts are forwarded', async () => {
    const t = setup();
    await t.mgr.start();
    const s = t.sessions[0]!;
    s.emit({ type: 'message', event: { providerMessageId: 'x' }, upsertType: 'notify', raw: {} });
    s.emit({
      type: 'status',
      update: { providerMessageId: 'out1', chat: TZVI_PN, status: 'delivered' },
    });
    await flush();
    expect(t.onMessage).toHaveBeenCalledTimes(1);
    expect(t.db.callsOf('applyMessageStatus')[0]?.slice(0, 3)).toEqual([ACC, 'out1', 'delivered']);
  });
});
