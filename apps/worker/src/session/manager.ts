/**
 * Multi-socket session manager (ARCH §2, §4.5, §4.6; ADR-4; TEST-PLAN S5, RL4).
 *
 * - One BaileysSession per Baileys account, only while this worker holds the account lease
 *   (`worker_try_lock_account`, renewed every ≤30 s). Lease refused → socket closed at once (S5).
 * - Session events → `worker_session_event` (serialised per account, via `sessionEventRow`).
 * - Delivery receipts → `apply_message_status`.
 * - `session_commands` (reconnect / logout / pair) and `pairing_requests` (QR or pairing code →
 *   `worker_pairing_qr_upsert`, `worker_pairing_finish` on open). QR / pairing codes are secrets:
 *   never logged, only written to the owner-only `pairing_qr` row.
 */
import { normalizeJid, type ConnectionState, type SessionHealth } from '@htz/core';
import {
  hashId,
  sessionEventRow,
  type PairingMode,
  type ProviderSession,
  type SelfIdentity,
  type SessionEvent,
  type SessionEventListener,
} from '@htz/provider-baileys';
import type { Logger } from 'pino';
import type { PairingRequestRow, SessionCommandRow, SessionEventName, WorkerDb } from '../db/types';
import type { InboundMessageEvent } from '../inbound/pipeline';

/** The subset of BaileysSession the manager drives (tests use fakes). */
export interface ManagedSession extends ProviderSession {
  readonly me: SelfIdentity | null;
  readonly registered: boolean;
  start(): Promise<void>;
  close(): Promise<void>;
  logout(): Promise<void>;
  on(listener: SessionEventListener): () => void;
  health(): SessionHealth;
  pnForLid(lid: string): Promise<string | null>;
  lidForPn(pn: string): Promise<string | null>;
  downloadMedia(raw: never): Promise<Buffer>;
}

export type SessionFactory = (accountId: string, pairing: PairingMode) => ManagedSession;

export interface SessionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface SessionManagerDeps {
  orgId: string;
  workerId: string;
  db: Pick<
    WorkerDb,
    | 'listBaileysAccounts'
    | 'tryLockAccount'
    | 'unlockAccount'
    | 'sessionEvent'
    | 'completeSessionCommand'
    | 'listPendingSessionCommands'
    | 'listPendingPairingRequests'
    | 'pairingQrUpsert'
    | 'pairingFinish'
    | 'applyMessageStatus'
  >;
  createSession: SessionFactory;
  provider: { register(s: ProviderSession): void; unregister(accountId: string): void };
  onMessage: (e: InboundMessageEvent) => void;
  /** Session reached `open` (e.g. relay restart recovery). */
  onOpen?: (accountId: string) => void;
  log: Logger;
  /** Lease TTL passed to worker_try_lock_account. Default 90 s (renew every ≤30 s). */
  lockTtlSeconds?: number;
  now?: () => number;
  timers?: SessionTimers;
}

interface Entry {
  accountId: string;
  session: ManagedSession;
  off: () => void;
  lastLockOkAt: number;
  pairing: PairingRequestRow | null;
  pairingTimer: unknown;
  chain: Promise<void>;
  closing: boolean;
  lastEvent: SessionEventName | null;
}

/** Account statuses that mean "was paired before": start the socket at boot. */
const AUTOSTART: ReadonlySet<string> = new Set(['open', 'connecting', 'closed']);

export class SessionManager {
  readonly #d: SessionManagerDeps;
  readonly #entries = new Map<string, Entry>();
  readonly #busyCommands = new Set<string>();
  readonly #handledPairing = new Set<string>();
  readonly #now: () => number;
  readonly #timers: SessionTimers;
  #stopping = false;

  constructor(deps: SessionManagerDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
  }

  get ttlSeconds(): number {
    return this.#d.lockTtlSeconds ?? 90;
  }

  session(accountId: string): ManagedSession | null {
    return this.#entries.get(accountId)?.session ?? null;
  }

  state(accountId: string): ConnectionState | null {
    return this.#entries.get(accountId)?.session.state ?? null;
  }

  /** Per-socket heartbeat payload (no secrets, no numbers). */
  sockets(): Array<{
    account_id: string;
    connection: ConnectionState;
    connected_at: string | null;
    last_error_code: string | null;
  }> {
    return [...this.#entries.values()].map((e) => {
      const h = e.session.health();
      return {
        account_id: e.accountId,
        connection: h.connection,
        connected_at: h.connectedAt,
        last_error_code: h.lastErrorCode,
      };
    });
  }

  /** Boot: start every previously paired Baileys account this worker can lock. */
  async start(): Promise<void> {
    const accounts = await this.#d.db.listBaileysAccounts(this.#d.orgId);
    for (const a of accounts) {
      if (!AUTOSTART.has(a.status)) continue;
      await this.#startSession(a.id, { mode: 'qr' }, null).catch((err: Error) =>
        this.#d.log.error({ account: hashId(a.id), err: err.name }, 'session_start_failed'),
      );
    }
  }

  // ------------------------------------------------------------------ single writer (S5)

  /** Renew every held lease; a refused lease closes that socket immediately. */
  async renewLocks(): Promise<void> {
    const ttlMs = this.ttlSeconds * 1000;
    for (const e of [...this.#entries.values()]) {
      if (e.closing) continue;
      let ok: boolean | null;
      try {
        ok = await this.#d.db.tryLockAccount(e.accountId, this.#d.workerId, this.ttlSeconds);
      } catch {
        ok = null;
      }
      if (ok === true) {
        e.lastLockOkAt = this.#now();
      } else if (ok === false) {
        this.#d.log.error({ account: hashId(e.accountId) }, 'lock_lost_closing_socket');
        await this.#teardown(e, { unlock: false, persist: false });
      } else if (this.#now() - e.lastLockOkAt > ttlMs - 15_000) {
        // Could not confirm the lease for almost a whole TTL: assume it is gone.
        this.#d.log.error({ account: hashId(e.accountId) }, 'lock_unconfirmed_closing_socket');
        await this.#teardown(e, { unlock: false, persist: false });
      }
    }
  }

  async #startSession(
    accountId: string,
    pairing: PairingMode,
    request: PairingRequestRow | null,
  ): Promise<Entry | null> {
    if (this.#stopping) return null;
    const existing = this.#entries.get(accountId);
    if (existing) return existing;
    const locked = await this.#d.db.tryLockAccount(accountId, this.#d.workerId, this.ttlSeconds);
    if (!locked) {
      // Another worker owns this account: never open a second socket (S5).
      this.#d.log.warn({ account: hashId(accountId) }, 'account_locked_elsewhere');
      return null;
    }
    const session = this.#d.createSession(accountId, pairing);
    const entry: Entry = {
      accountId,
      session,
      off: () => undefined,
      lastLockOkAt: this.#now(),
      pairing: request,
      pairingTimer: null,
      chain: Promise.resolve(),
      closing: false,
      lastEvent: null,
    };
    entry.off = session.on((e) => this.#onEvent(entry, e));
    this.#entries.set(accountId, entry);
    this.#d.provider.register(session);
    if (request) this.#armPairingExpiry(entry, request);
    await session.start();
    this.#d.log.info(
      { account: hashId(accountId), pairing: request ? request.method : null },
      'session_started',
    );
    return entry;
  }

  async #teardown(
    e: Entry,
    opts: { unlock: boolean; persist: boolean; logout?: boolean },
  ): Promise<void> {
    if (e.closing) return;
    e.closing = true;
    if (e.pairingTimer !== null) this.#timers.clearTimeout(e.pairingTimer);
    this.#d.provider.unregister(e.accountId);
    if (!opts.persist) e.off();
    try {
      if (opts.logout) await e.session.logout();
      else await e.session.close();
    } catch (err) {
      this.#d.log.warn(
        { account: hashId(e.accountId), err: (err as Error).name },
        'session_close_failed',
      );
    }
    if (opts.persist) {
      // The socket's own close event may arrive after close() resolves: record it explicitly.
      const terminal: ReadonlySet<SessionEventName | null> = new Set([
        'close',
        'conflict',
        'needs_relink',
        'logged_out',
      ]);
      if (!terminal.has(e.lastEvent)) this.#persist(e, 'close', null);
      e.off();
      await e.chain;
    }
    this.#entries.delete(e.accountId);
    if (opts.unlock) {
      await this.#d.db.unlockAccount(e.accountId, this.#d.workerId).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ events

  #persist(e: Entry, event: SessionEventName, code: number | string | null): void {
    e.lastEvent = event;
    e.chain = e.chain
      .then(async () => {
        await this.#d.db.sessionEvent(
          e.accountId,
          this.#d.workerId,
          event,
          code === null ? null : String(code),
        );
      })
      .catch((err: Error & { code?: string }) => {
        this.#d.log.warn(
          { account: hashId(e.accountId), event, err: err.name },
          'session_event_persist_failed',
        );
        if (/55P03/.test(`${err.code ?? ''} ${err.message ?? ''}`) && !e.closing) {
          // Another worker holds the lock now (S5).
          void this.#teardown(e, { unlock: false, persist: false });
        }
      });
  }

  #run(e: Entry, fn: () => Promise<unknown>, what: string): void {
    e.chain = e.chain.then(fn).then(
      () => undefined,
      (err: Error) =>
        this.#d.log.warn(
          { account: hashId(e.accountId), what, err: err.name },
          'session_task_failed',
        ),
    );
  }

  #onEvent(e: Entry, ev: SessionEvent): void {
    const log = this.#d.log;
    switch (ev.type) {
      case 'connecting':
        this.#persist(e, 'connecting', null);
        return;
      case 'qr':
      case 'pairing_code': {
        this.#persist(e, 'qr', null);
        const req = e.pairing;
        if (!req) return; // nobody is pairing: the QR goes nowhere (never logged)
        const secret = ev.type === 'qr' ? { qr: ev.qr } : { pairingCode: ev.code };
        this.#run(
          e,
          () => this.#d.db.pairingQrUpsert(req.id, this.#d.workerId, secret),
          'pairing_qr_upsert',
        );
        return;
      }
      case 'open': {
        const event: SessionEventName =
          ev.restored && ev.reconnectMs === null ? 'restored' : 'open';
        this.#persist(e, event, null);
        const req = e.pairing;
        if (req) {
          e.pairing = null;
          if (e.pairingTimer !== null) this.#timers.clearTimeout(e.pairingTimer);
          const phone = ev.me.pn ? normalizeJid(ev.me.pn) : null;
          const e164 = phone?.ok ? phone.value.e164 : null;
          this.#run(
            e,
            () => this.#d.db.pairingFinish(req.id, this.#d.workerId, 'paired', e164),
            'pairing_finish',
          );
          log.info({ account: hashId(e.accountId) }, 'paired');
        }
        this.#d.onOpen?.(e.accountId);
        return;
      }
      case 'relinked':
      case 'close':
      case 'conflict': {
        const row = sessionEventRow(ev);
        if (row) this.#persist(e, row.event, row.code);
        if (ev.type === 'conflict') {
          // ARCH §4.6: another client on the number or a ban signal → stop, P1, no auto-retry.
          void e.chain.then(() => this.#teardown(e, { unlock: true, persist: true }));
        }
        return;
      }
      case 'needs_relink':
        this.#persist(e, ev.reason === 'bad_session' ? 'needs_relink' : 'logged_out', ev.code);
        void e.chain.then(() => this.#teardown(e, { unlock: true, persist: true }));
        return;
      case 'pairing_expired': {
        const req = e.pairing;
        e.pairing = null;
        if (req)
          this.#run(
            e,
            () => this.#d.db.pairingFinish(req.id, this.#d.workerId, 'expired'),
            'pairing_expired',
          );
        void e.chain.then(() => this.#teardown(e, { unlock: true, persist: true }));
        return;
      }
      case 'message':
        this.#d.onMessage({
          accountId: e.accountId,
          event: ev.event,
          upsertType: ev.upsertType,
          raw: ev.raw,
        });
        return;
      case 'status': {
        const s = ev.update.status;
        if (s === 'sent' || s === 'delivered' || s === 'read' || s === 'failed') {
          this.#run(
            e,
            () => this.#d.db.applyMessageStatus(e.accountId, ev.update.providerMessageId, s, ev.at),
            'apply_status',
          );
        }
        return;
      }
      case 'decrypt_failure':
        log.warn({ account: hashId(e.accountId), chatKind: ev.chatKind }, 'decrypt_failure');
        return;
      case 'store_error':
        log.error({ account: hashId(e.accountId), op: ev.op }, 'session_store_error');
        return;
      case 'reconnecting':
        return;
    }
  }

  // ------------------------------------------------------------------ commands / pairing

  /** Poll pass (also triggered by Realtime INSERTs): pending commands and pairing requests. */
  async syncCommands(): Promise<void> {
    if (this.#stopping) return;
    const [cmds, reqs] = await Promise.all([
      this.#d.db.listPendingSessionCommands(this.#d.orgId),
      this.#d.db.listPendingPairingRequests(this.#d.orgId),
    ]);
    for (const c of cmds) await this.handleCommand(c);
    for (const r of reqs) await this.handlePairingRequest(r);
  }

  async handleCommand(c: SessionCommandRow): Promise<void> {
    if (this.#busyCommands.has(c.id) || c.state !== 'pending') return;
    this.#busyCommands.add(c.id);
    const log = this.#d.log.child({ account: hashId(c.account_id), command: c.command });
    try {
      if (c.command === 'mark_read') {
        await this.#markRead(c, log);
        return;
      }
      let e = this.#entries.get(c.account_id);
      if (!e) {
        // Only act if we can own the account; otherwise leave it for the worker that does.
        const ok = await this.#d.db.tryLockAccount(c.account_id, this.#d.workerId, this.ttlSeconds);
        if (!ok) return;
      }
      let result: string;
      switch (c.command) {
        case 'reconnect':
        case 'pair':
          if (e && c.command === 'pair' && e.session.state === 'open') {
            result = 'already_open';
            break;
          }
          if (e) await this.#teardown(e, { unlock: false, persist: true });
          e = (await this.#startSession(c.account_id, { mode: 'qr' }, null)) ?? undefined;
          result = e ? 'restarted' : 'locked_elsewhere';
          break;
        case 'logout':
          if (!e) {
            await this.#d.db.unlockAccount(c.account_id, this.#d.workerId).catch(() => undefined);
            result = 'not_running';
            break;
          }
          await this.#teardown(e, { unlock: true, persist: true, logout: true });
          result = 'logged_out';
          break;
      }
      await this.#d.db.completeSessionCommand(
        c.id,
        result === 'locked_elsewhere' ? 'failed' : 'done',
        result,
      );
      log.info({ result }, 'session_command_done');
    } catch (err) {
      log.error({ err: (err as Error).name }, 'session_command_failed');
      await this.#d.db.completeSessionCommand(c.id, 'failed', 'error').catch(() => undefined);
    } finally {
      this.#busyCommands.delete(c.id);
    }
  }

  /** MCP mark_read (read receipts) on the socket this worker holds. Ids never logged. */
  async #markRead(c: SessionCommandRow, log: Logger): Promise<void> {
    const chat = typeof c.payload?.chat === 'string' ? c.payload.chat : null;
    const rawIds = Array.isArray(c.payload?.ids) ? (c.payload.ids as unknown[]) : [];
    const ids = rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
    const target = chat ? normalizeJid(chat) : null;
    if (!target?.ok || ids.length === 0) {
      await this.#d.db.completeSessionCommand(c.id, 'failed', 'invalid_payload');
      return;
    }
    const e = this.#entries.get(c.account_id);
    if (!e) {
      // Not ours unless nobody holds the account: then nobody can mark it read right now.
      const ok = await this.#d.db.tryLockAccount(c.account_id, this.#d.workerId, this.ttlSeconds);
      if (!ok) return;
      await this.#d.db.unlockAccount(c.account_id, this.#d.workerId).catch(() => undefined);
      await this.#d.db.completeSessionCommand(c.id, 'failed', 'not_running');
      return;
    }
    if (e.session.state !== 'open') {
      await this.#d.db.completeSessionCommand(c.id, 'failed', 'session_disconnected');
      return;
    }
    await e.session.markRead(target.value.jid, ids);
    await this.#d.db.completeSessionCommand(c.id, 'done', `marked:${ids.length}`);
    log.info({ n: ids.length }, 'session_command_done');
  }

  async handlePairingRequest(r: PairingRequestRow): Promise<void> {
    if (this.#handledPairing.has(r.id)) return;
    if (Date.parse(r.expires_at) <= this.#now()) return;
    const existing = this.#entries.get(r.account_id);
    if (existing && existing.pairing?.id === r.id) return;
    if (!existing) {
      const ok = await this.#d.db.tryLockAccount(r.account_id, this.#d.workerId, this.ttlSeconds);
      if (!ok) return;
    }
    this.#handledPairing.add(r.id);
    const log = this.#d.log.child({ account: hashId(r.account_id) });
    if (existing?.session.state === 'open') {
      const phone = existing.session.me?.pn ? normalizeJid(existing.session.me.pn) : null;
      await this.#d.db.pairingFinish(
        r.id,
        this.#d.workerId,
        'paired',
        phone?.ok ? phone.value.e164 : null,
      );
      log.info({}, 'pairing_request_already_open');
      return;
    }
    if (existing) await this.#teardown(existing, { unlock: false, persist: true });
    const mode: PairingMode =
      r.method === 'pairing_code' && r.phone_e164
        ? { mode: 'code', phoneNumber: r.phone_e164 }
        : { mode: 'qr' };
    const e = await this.#startSession(r.account_id, mode, r);
    log.info({ method: r.method, started: Boolean(e) }, 'pairing_started');
  }

  #armPairingExpiry(e: Entry, r: PairingRequestRow): void {
    const ms = Math.max(0, Date.parse(r.expires_at) - this.#now());
    e.pairingTimer = this.#timers.setTimeout(() => {
      if (e.pairing?.id !== r.id) return;
      e.pairing = null;
      this.#run(
        e,
        () => this.#d.db.pairingFinish(r.id, this.#d.workerId, 'expired'),
        'pairing_expired',
      );
      if (!e.session.registered || e.session.state !== 'open') {
        void e.chain.then(() => this.#teardown(e, { unlock: true, persist: true }));
      }
    }, ms);
  }

  // ------------------------------------------------------------------ shutdown

  /** SIGTERM: close every socket WITHOUT logout (session restorable), then release locks. */
  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.all(
      [...this.#entries.values()].map((e) => this.#teardown(e, { unlock: true, persist: true })),
    );
  }
}
