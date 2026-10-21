/**
 * One Baileys 7.x socket for one account (rewrite of legacy whatsapp.ts). Owns the reconnect
 * policy (ARCH §4.6), pairing by QR or pairing code (§4.5), inbound normalisation (§4.4) and the
 * real `getMessage` backed by the encrypted SessionStore. Every transition is emitted as a typed
 * `SessionEvent`; `sessionEventRow()` maps the persisted ones to `session_events`.
 *
 * Logging: never message content, QR, pairing code or full JIDs (hashId only).
 */
import {
  downloadMediaMessage,
  generateMessageIDV2,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeWASocket,
  type AnyMessageContent,
  type BaileysEventMap,
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from 'baileys';
import type { Logger } from 'pino';
import {
  jidKind,
  type ConnectionState,
  type InboundEvent,
  type Presence,
  type SessionHealth,
} from '@htz/core';
import { createStoreAuthState, type StoreAuthState } from './auth-state';
import {
  classifyDisconnect,
  disconnectCode,
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type DisconnectAction,
} from './disconnect';
import {
  isDecryptFailure,
  mapStatusUpdate,
  normalizeInbound,
  type SelfIdentity,
  type StatusUpdate,
} from './inbound';
import { createLogger, hashId } from './log';
import type { SessionStore } from './store/types';

/** Subset of the Baileys socket the session uses (keeps tests honest without a live socket). */
export type BaileysSocket = Pick<
  WASocket,
  | 'ev'
  | 'user'
  | 'sendMessage'
  | 'readMessages'
  | 'sendPresenceUpdate'
  | 'logout'
  | 'end'
  | 'requestPairingCode'
  | 'groupMetadata'
  | 'updateMediaMessage'
  | 'signalRepository'
>;

export type PairingMode = { mode: 'qr' } | { mode: 'code'; phoneNumber: string };

export type SessionEventBody =
  | { type: 'connecting'; attempt: number; registered: boolean }
  /** SECRET: the QR payload. Forward only to the encrypted pairing_qr row; never log. */
  | { type: 'qr'; qr: string }
  /** SECRET: the 8-char pairing code. Never log. */
  | { type: 'pairing_code'; code: string }
  | { type: 'pairing_expired'; attempts: number }
  | {
      type: 'open';
      me: SelfIdentity;
      isNewLogin: boolean;
      /** creds came from the store (process restart without re-pairing). */
      restored: boolean;
      /** ms from `start()` to this open. */
      sinceStartMs: number;
      /** ms from the previous close to this open, null for the first open. */
      reconnectMs: number | null;
    }
  | { type: 'relinked'; me: SelfIdentity }
  | {
      type: 'close';
      code: number | null;
      action: DisconnectAction | 'stopped';
      reconnectInMs: number | null;
    }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'needs_relink'; code: number | null; reason: 'logged_out' | 'bad_session' | 'logout' }
  | { type: 'conflict'; code: number | null }
  | { type: 'decrypt_failure'; providerMessageId: string; chatKind: string; detail: string | null }
  | {
      type: 'message';
      event: InboundEvent;
      upsertType: 'notify' | 'append';
      /** Raw message, needed for downloadMedia / quoting. Contains content: never log. */
      raw: WAMessage;
    }
  | { type: 'status'; update: StatusUpdate }
  | { type: 'store_error'; op: string; detail: string };

export type SessionEvent = SessionEventBody & { accountId: string; at: string };
export type SessionEventListener = (e: SessionEvent) => void;

/** Row for `session_events(account_id, event, code, at)` or null if not persisted. */
export function sessionEventRow(e: SessionEvent): {
  account_id: string;
  event: 'open' | 'close' | 'qr' | 'relinked' | 'conflict';
  code: number | null;
  at: string;
} | null {
  const base = { account_id: e.accountId, at: e.at };
  switch (e.type) {
    case 'open':
      return { ...base, event: 'open', code: null };
    case 'close':
      return { ...base, event: 'close', code: e.code };
    case 'qr':
    case 'pairing_code':
      return { ...base, event: 'qr', code: null };
    case 'relinked':
      return { ...base, event: 'relinked', code: null };
    case 'conflict':
      return { ...base, event: 'conflict', code: e.code };
    default:
      return null;
  }
}

export class SessionNotOpenError extends Error {
  constructor(readonly state: ConnectionState) {
    super(`session_not_open: ${state}`);
    this.name = 'SessionNotOpenError';
  }
}

export class QuotedMessageNotFoundError extends Error {
  constructor() {
    super('quoted_message_unknown');
    this.name = 'QuotedMessageNotFoundError';
  }
}

export interface SessionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BaileysSessionOptions {
  accountId: string;
  store: SessionStore;
  /** Default QR. The spike uses `{ mode: 'code', phoneNumber: '+972…' }`. */
  pairing?: PairingMode;
  logger?: Logger;
  /** Level for Baileys' own (very chatty, JID-heavy) logs. Default 'warn'. */
  baileysLogLevel?: string;
  /** Extra socket config (version, browser, timeouts). Safety-relevant keys are forced. */
  socketConfig?: Partial<
    Omit<
      UserFacingSocketConfig,
      | 'auth'
      | 'getMessage'
      | 'cachedGroupMetadata'
      | 'markOnlineOnConnect'
      | 'syncFullHistory'
      | 'shouldSyncHistoryMessage'
      | 'logger'
    >
  >;
  /** Socket attempts while unregistered before giving up with `pairing_expired`. Default 3. */
  maxPairingAttempts?: number;
  reconnect?: { baseMs?: number; maxMs?: number };
  groupMetadataTtlMs?: number;
  /** Test seams. */
  makeSocket?: (config: UserFacingSocketConfig) => BaileysSocket;
  now?: () => number;
  timers?: SessionTimers;
}

const INBOUND_CACHE_MAX = 1_000;

export class BaileysSession {
  readonly accountId: string;
  readonly #store: SessionStore;
  readonly #pairing: PairingMode;
  readonly #log: Logger;
  readonly #baileysLog: Logger;
  readonly #opts: BaileysSessionOptions;
  readonly #now: () => number;
  readonly #timers: SessionTimers;
  readonly #listeners = new Set<SessionEventListener>();
  readonly #groupCache = new Map<string, { meta: GroupMetadata; exp: number }>();
  readonly #inbound = new Map<string, WAMessage>();

  #auth: StoreAuthState | null = null;
  #sock: BaileysSocket | null = null;
  #state: ConnectionState = 'closed';
  #started = false;
  #stopping = false;
  #attempt = 0;
  #pairingAttempts = 0;
  #pendingNewLogin = false;
  #startedAt = 0;
  #connectedAt: number | null = null;
  #lastCloseAt: number | null = null;
  #lastHeartbeatAt: number | null = null;
  #lastErrorCode: string | null = null;
  #reconnectTimer: unknown = null;
  #me: SelfIdentity | null = null;

  constructor(opts: BaileysSessionOptions) {
    this.accountId = opts.accountId;
    this.#opts = opts;
    this.#store = opts.store;
    this.#pairing = opts.pairing ?? { mode: 'qr' };
    if (this.#pairing.mode === 'code' && !/^\+?\d{8,15}$/.test(this.#pairing.phoneNumber))
      throw new Error('pairing phoneNumber must be E.164');
    this.#log = (opts.logger ?? createLogger()).child({ account: hashId(opts.accountId) });
    this.#baileysLog = this.#log.child(
      { mod: 'baileys' },
      { level: opts.baileysLogLevel ?? 'warn' },
    );
    this.#now = opts.now ?? Date.now;
    this.#timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
  }

  // ------------------------------------------------------------------ events

  on(listener: SessionEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(body: SessionEventBody): void {
    const e = { ...body, accountId: this.accountId, at: new Date(this.#now()).toISOString() };
    for (const l of this.#listeners) {
      try {
        l(e as SessionEvent);
      } catch (err) {
        this.#log.error({ err: (err as Error).name }, 'session_listener_error');
      }
    }
  }

  // ------------------------------------------------------------------ state

  get state(): ConnectionState {
    return this.#state;
  }

  get me(): SelfIdentity | null {
    return this.#me;
  }

  /** True when the stored creds belong to a paired device. */
  get registered(): boolean {
    return Boolean(this.#auth?.state.creds.registered || this.#auth?.state.creds.me?.id);
  }

  health(): SessionHealth {
    return {
      accountId: this.accountId,
      provider: 'baileys',
      connection: this.#state,
      connectedAt: this.#connectedAt ? new Date(this.#connectedAt).toISOString() : null,
      lastHeartbeatAt: this.#lastHeartbeatAt ? new Date(this.#lastHeartbeatAt).toISOString() : null,
      lastErrorCode: this.#lastErrorCode,
    };
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#startedAt = this.#now();
    this.#auth = await createStoreAuthState(this.#store, this.#baileysLog);
    this.#connect();
  }

  #connect(): void {
    if (this.#stopping || !this.#auth) return;
    const registered = this.registered;
    if (!registered) {
      this.#pairingAttempts += 1;
      const max = this.#opts.maxPairingAttempts ?? 3;
      if (this.#pairingAttempts > max) {
        this.#log.warn({ attempts: max }, 'pairing_expired');
        this.#state = 'closed';
        this.#started = false;
        this.#emit({ type: 'pairing_expired', attempts: max });
        return;
      }
    }
    this.#state = 'connecting';
    this.#emit({ type: 'connecting', attempt: this.#attempt, registered });
    const config: UserFacingSocketConfig = {
      ...this.#opts.socketConfig,
      auth: this.#auth.state,
      logger: this.#baileysLog,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async (key) => this.#getMessage(key),
      cachedGroupMetadata: async (jid) => this.#cachedGroup(jid),
    };
    const sock = (this.#opts.makeSocket ?? ((c) => makeWASocket(c)))(config);
    this.#sock = sock;
    let pairingRequested = false;
    sock.ev.process(async (events) => {
      if (this.#sock !== sock) return; // stale socket
      try {
        await this.#handle(sock, events, () => {
          const first = !pairingRequested;
          pairingRequested = true;
          return first;
        });
      } catch (err) {
        this.#log.error({ err: (err as Error).name }, 'session_event_handler_error');
      }
    });
  }

  async #handle(
    sock: BaileysSocket,
    events: Partial<BaileysEventMap>,
    firstPairingRequest: () => boolean,
  ): Promise<void> {
    if (events['creds.update']) {
      try {
        await this.#auth?.saveCreds();
      } catch (err) {
        this.#lastErrorCode = 'store_error';
        this.#log.error({ err: (err as Error).name }, 'creds_save_failed');
        this.#emit({ type: 'store_error', op: 'saveCreds', detail: (err as Error).name });
      }
    }

    const cu = events['connection.update'];
    if (cu) {
      if (cu.isNewLogin) this.#pendingNewLogin = true;
      if (cu.qr) await this.#onQr(sock, cu.qr, firstPairingRequest);
      if (cu.connection === 'open') this.#onOpen(sock);
      if (cu.connection === 'close') await this.#onClose(disconnectCode(cu.lastDisconnect?.error));
    }

    const up = events['messages.upsert'];
    if (up) {
      for (const msg of up.messages) {
        if (isDecryptFailure(msg)) {
          const p = msg.messageStubParameters as unknown[] | undefined;
          this.#emit({
            type: 'decrypt_failure',
            providerMessageId: msg.key.id ?? '',
            chatKind: jidKind(msg.key.remoteJid),
            detail: typeof p?.[0] === 'string' ? p[0].slice(0, 120) : null,
          });
          this.#log.warn({ chatKind: jidKind(msg.key.remoteJid) }, 'decrypt_failure');
          continue;
        }
        const ev = normalizeInbound(msg, this.accountId, this.#me ?? undefined);
        if (!ev) continue;
        this.#rememberInbound(msg);
        this.#emit({ type: 'message', event: ev, upsertType: up.type, raw: msg });
      }
      this.#lastHeartbeatAt = this.#now();
    }

    const mu = events['messages.update'];
    if (mu) {
      for (const u of mu) {
        const s = mapStatusUpdate(u);
        if (s) this.#emit({ type: 'status', update: s });
      }
    }

    for (const g of events['groups.update'] ?? []) if (g.id) this.#groupCache.delete(g.id);
    const gp = events['group-participants.update'];
    if (gp) this.#groupCache.delete(gp.id);
  }

  async #onQr(sock: BaileysSocket, qr: string, firstPairingRequest: () => boolean): Promise<void> {
    if (this.#pairing.mode === 'qr') {
      this.#emit({ type: 'qr', qr });
      return;
    }
    // Pairing-code mode: the socket is ready for registration once it offers a QR.
    if (!firstPairingRequest()) return;
    try {
      const digits = this.#pairing.phoneNumber.replace(/\D/g, '');
      const code = await sock.requestPairingCode(digits);
      this.#emit({ type: 'pairing_code', code });
      this.#log.info({}, 'pairing_code_issued');
    } catch (err) {
      this.#lastErrorCode = `pairing_code:${disconnectCode(err) ?? 'error'}`;
      this.#log.warn({ statusCode: disconnectCode(err) ?? null }, 'pairing_code_failed');
    }
  }

  #onOpen(sock: BaileysSocket): void {
    const now = this.#now();
    const user = sock.user;
    const me: SelfIdentity = {
      pn: user?.id && isPnUser(jidNormalizedUser(user.id)) ? jidNormalizedUser(user.id) : null,
      lid: user?.lid
        ? jidNormalizedUser(user.lid)
        : user?.id && isLidUser(jidNormalizedUser(user.id))
          ? jidNormalizedUser(user.id)
          : null,
    };
    this.#me = me;
    this.#state = 'open';
    this.#connectedAt = now;
    this.#lastHeartbeatAt = now;
    this.#lastErrorCode = null;
    this.#attempt = 0;
    this.#pairingAttempts = 0;
    const isNewLogin = this.#pendingNewLogin;
    this.#pendingNewLogin = false;
    const reconnectMs = this.#lastCloseAt === null ? null : now - this.#lastCloseAt;
    this.#log.info({ isNewLogin, reconnectMs }, 'connection_open');
    this.#emit({
      type: 'open',
      me,
      isNewLogin,
      restored: Boolean(this.#auth && !isNewLogin && this.#authRestored()),
      sinceStartMs: now - this.#startedAt,
      reconnectMs,
    });
    if (isNewLogin) this.#emit({ type: 'relinked', me });
  }

  #authRestored(): boolean {
    return this.#auth?.restored ?? false;
  }

  async #onClose(code: number | undefined): Promise<void> {
    const now = this.#now();
    this.#lastCloseAt = now;
    this.#connectedAt = null;
    const codeOrNull = code ?? null;
    if (codeOrNull !== null) this.#lastErrorCode = String(codeOrNull);

    if (this.#stopping) {
      this.#state = this.#state === 'needs_relink' ? 'needs_relink' : 'closed';
      this.#emit({ type: 'close', code: codeOrNull, action: 'stopped', reconnectInMs: null });
      return;
    }

    const action = classifyDisconnect(code);
    this.#log.info({ statusCode: codeOrNull, action }, 'connection_close');

    if (action === 'needs_relink') {
      this.#state = 'needs_relink';
      this.#started = false;
      this.#sock = null;
      this.#emit({ type: 'close', code: codeOrNull, action, reconnectInMs: null });
      await this.#wipe();
      this.#emit({
        type: 'needs_relink',
        code: codeOrNull,
        reason: code === 401 ? 'logged_out' : 'bad_session',
      });
      return;
    }
    if (action === 'conflict') {
      this.#state = 'conflict';
      this.#started = false;
      this.#sock = null;
      this.#emit({ type: 'close', code: codeOrNull, action, reconnectInMs: null });
      this.#emit({ type: 'conflict', code: codeOrNull });
      return;
    }

    let delay: number;
    if (action === 'restart') {
      this.#attempt = 0;
      delay = 0;
    } else {
      delay = reconnectDelayMs(
        this.#attempt,
        this.#opts.reconnect?.baseMs ?? RECONNECT_BASE_MS,
        this.#opts.reconnect?.maxMs ?? RECONNECT_MAX_MS,
      );
      this.#attempt += 1;
    }
    this.#state = 'connecting';
    this.#emit({ type: 'close', code: codeOrNull, action, reconnectInMs: delay });
    this.#emit({ type: 'reconnecting', attempt: this.#attempt, delayMs: delay });
    this.#sock = null;
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  async #wipe(): Promise<void> {
    try {
      await this.#auth?.state.keys.clear?.();
      await this.#store.clear();
    } catch (err) {
      this.#log.error({ err: (err as Error).name }, 'store_wipe_failed');
      this.#emit({ type: 'store_error', op: 'clear', detail: (err as Error).name });
    }
  }

  /** Stop without logging out (process shutdown). Session can be restored on next start. */
  async close(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#reconnectTimer !== null) this.#timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const sock = this.#sock;
    if (sock) await sock.end(undefined);
    if (this.#state !== 'needs_relink' && this.#state !== 'conflict') this.#state = 'closed';
  }

  /** Unlink this device from the phone and wipe the store. */
  async logout(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#reconnectTimer !== null) this.#timers.clearTimeout(this.#reconnectTimer);
    const sock = this.#sock;
    try {
      if (sock) await sock.logout();
    } catch (err) {
      this.#log.warn({ statusCode: disconnectCode(err) ?? null }, 'logout_failed');
    }
    this.#state = 'needs_relink';
    await this.#wipe();
    this.#emit({ type: 'needs_relink', code: null, reason: 'logout' });
  }

  // ------------------------------------------------------------------ helpers for send/receive

  #requireOpen(): BaileysSocket {
    if (this.#state !== 'open' || !this.#sock) throw new SessionNotOpenError(this.#state);
    return this.#sock;
  }

  #rememberInbound(msg: WAMessage): void {
    const id = msg.key.id;
    if (!id) return;
    this.#inbound.delete(id);
    this.#inbound.set(id, msg);
    if (this.#inbound.size > INBOUND_CACHE_MAX) {
      const oldest = this.#inbound.keys().next().value;
      if (oldest !== undefined) this.#inbound.delete(oldest);
    }
  }

  async #getMessage(key: WAMessageKey) {
    if (!key.id) return undefined;
    try {
      return await this.#store.getSentMessage(key.id);
    } catch (err) {
      this.#log.warn({ err: (err as Error).name }, 'get_message_failed');
      return undefined;
    }
  }

  async #cachedGroup(jid: string): Promise<GroupMetadata | undefined> {
    const hit = this.#groupCache.get(jid);
    if (hit && hit.exp > this.#now()) return hit.meta;
    return undefined;
  }

  async #ensureGroupCached(sock: BaileysSocket, jid: string): Promise<void> {
    if (!jid.endsWith('@g.us') || (await this.#cachedGroup(jid))) return;
    const meta = await sock.groupMetadata(jid);
    this.#groupCache.set(jid, {
      meta,
      exp: this.#now() + (this.#opts.groupMetadataTtlMs ?? 5 * 60_000),
    });
  }

  async #quoted(jid: string, quotedId: string): Promise<WAMessage> {
    const inbound = this.#inbound.get(quotedId);
    if (inbound) return inbound;
    const sent = await this.#store.getSentMessage(quotedId);
    if (sent) return { key: { remoteJid: jid, id: quotedId, fromMe: true }, message: sent };
    throw new QuotedMessageNotFoundError();
  }

  // ------------------------------------------------------------------ public actions

  /**
   * A fresh WhatsApp message id (same generator Baileys uses). Reserve it in the DB
   * (`job_reserve_provider_id`) and pass it as `messageId` so a crash between send and commit
   * never causes a second, different message (RL2): a resend with the same id is deduped.
   */
  newMessageId(): string {
    return generateMessageIDV2(this.#sock?.user?.id);
  }

  /** True when this device recorded a send with this id (the store's sent-message record). */
  async wasSent(id: string): Promise<boolean> {
    return Boolean(await this.#store.getSentMessage(id));
  }

  /**
   * Sends any Baileys content. Records the message for `getMessage` retries. `messageId`
   * overrides the generated id (Baileys `MiscMessageGenerationOptions.messageId`).
   */
  async sendMessage(
    jid: string,
    content: AnyMessageContent,
    opts: { quotedId?: string; messageId?: string } = {},
  ): Promise<{ id: string; message: WAMessage }> {
    const sock = this.#requireOpen();
    await this.#ensureGroupCached(sock, jid);
    const misc: MiscMessageGenerationOptions = {};
    if (opts.messageId) misc.messageId = opts.messageId;
    if (opts.quotedId) misc.quoted = await this.#quoted(jid, opts.quotedId);
    const sent = await sock.sendMessage(jid, content, misc);
    if (!sent?.key.id) throw new Error('send_returned_no_id');
    if (sent.message) {
      try {
        await this.#store.recordSentMessage(sent.key.id, sent.message);
      } catch (err) {
        this.#log.warn({ err: (err as Error).name }, 'record_sent_failed');
      }
    }
    this.#lastHeartbeatAt = this.#now();
    return { id: sent.key.id, message: sent };
  }

  sendText(jid: string, text: string, opts: { quotedId?: string; messageId?: string } = {}) {
    return this.sendMessage(jid, { text }, opts);
  }

  async react(jid: string, targetId: string, emoji: string, opts: { messageId?: string } = {}) {
    const inbound = this.#inbound.get(targetId);
    const key: WAMessageKey = inbound
      ? inbound.key
      : {
          remoteJid: jid,
          id: targetId,
          fromMe: Boolean(await this.#store.getSentMessage(targetId)),
        };
    return this.sendMessage(jid, { react: { text: emoji, key } }, opts);
  }

  async markRead(chat: string, ids: readonly string[]): Promise<void> {
    const sock = this.#requireOpen();
    const keys: WAMessageKey[] = ids.map(
      (id) => this.#inbound.get(id)?.key ?? { remoteJid: chat, id, fromMe: false },
    );
    if (keys.length) await sock.readMessages(keys);
  }

  async presence(chat: string, p: Presence): Promise<void> {
    const sock = this.#requireOpen();
    await sock.sendPresenceUpdate(p, chat);
  }

  async downloadMedia(raw: WAMessage): Promise<Buffer> {
    const sock = this.#requireOpen();
    return downloadMediaMessage(
      raw,
      'buffer',
      {},
      { reuploadRequest: (m) => sock.updateMediaMessage(m), logger: this.#baileysLog },
    );
  }

  /** LID ↔ PN through Baileys' persisted `lid-mapping` store. */
  async pnForLid(lid: string): Promise<string | null> {
    const sock = this.#sock;
    if (!sock) return null;
    const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
    return pn ? jidNormalizedUser(pn) : null;
  }

  async lidForPn(pn: string): Promise<string | null> {
    const sock = this.#sock;
    if (!sock) return null;
    const lid = await sock.signalRepository.lidMapping.getLIDForPN(pn);
    return lid ? jidNormalizedUser(lid) : null;
  }
}
