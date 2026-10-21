/**
 * `BaileysProvider implements WhatsAppProvider` (ARCH §3). Routes by accountId to registered
 * sessions, enforces capability flags (no silent fallback, RL7), ban-risk pacing and the
 * circuit breaker (§7.8), and maps Baileys failures to GatewayErrorCodes.
 * Policy (`assertChatAllowed`, use cases, may_initiate) runs BEFORE this, in the worker send path.
 */
import path from 'node:path';
import type { AnyMessageContent } from 'baileys';
import {
  BAILEYS_CAPABILITIES,
  gatewayError,
  normalizeJid,
  type Capabilities,
  type ConnectionState,
  type DeliveryMode,
  type GatewayError,
  type OutboundMedia,
  type OutboundMessage,
  type Presence,
  type SendResult,
  type SessionHealth,
  type WhatsAppProvider,
} from '@htz/core';
import type { Logger } from 'pino';
import { disconnectCode } from './disconnect';
import { createLogger, hashId } from './log';
import { CircuitBreaker, Pacer, type CircuitBreakerConfig } from './pacing';
import {
  QuotedMessageNotFoundError,
  SessionNotOpenError,
  type SessionEventListener,
} from './session';

/** What the provider needs from a session (BaileysSession satisfies it; tests use fakes). */
export interface ProviderSession {
  readonly accountId: string;
  readonly state: ConnectionState;
  health(): SessionHealth;
  on(listener: SessionEventListener): () => void;
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    opts?: { quotedId?: string },
  ): Promise<{ id: string }>;
  react(jid: string, targetId: string, emoji: string): Promise<{ id: string }>;
  markRead(chat: string, ids: readonly string[]): Promise<void>;
  presence(chat: string, p: Presence): Promise<void>;
}

/** Turns `OutboundMedia.storagePath` into bytes or a (signed, short-lived) URL. */
export type MediaResolver = (
  media: OutboundMedia,
  accountId: string,
) => Promise<Buffer | { url: string }>;

export interface BaileysProviderOptions {
  capabilities?: (accountId: string) => Capabilities;
  resolveMedia?: MediaResolver;
  /** `null` disables pacing (tests only). */
  pacer?: Pacer | null;
  breaker?: Partial<CircuitBreakerConfig>;
  /** Longer pacing waits are returned as `rate_limited` instead of sleeping. Default 30s. */
  maxInlineWaitMs?: number;
  /** Send `composing` while waiting out the jitter for text sends. Default true. */
  typingIndicator?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
}

export class BaileysProviderError extends Error {
  constructor(readonly gatewayError: GatewayError) {
    super(gatewayError.code);
    this.name = 'BaileysProviderError';
  }
}

const MAX_BUTTONS = 3;
const MAX_LIST_ROWS = 10;

/** Numbered-text rendering for interactive messages on personal accounts. */
export function renderNumberedText(body: string, options: readonly string[]): string {
  return [body.trim(), '', ...options.map((o, i) => `${i + 1}. ${o.trim()}`)].join('\n');
}

/** Maps errors thrown by Baileys / the session to a GatewayError. Never includes content. */
export function mapBaileysError(e: unknown): GatewayError {
  if (e instanceof BaileysProviderError) return e.gatewayError;
  if (e instanceof SessionNotOpenError) {
    if (e.state === 'needs_relink') return gatewayError('needs_relink');
    if (e.state === 'conflict') return gatewayError('conflict');
    return gatewayError('session_disconnected', `state:${e.state}`);
  }
  if (e instanceof QuotedMessageNotFoundError)
    return gatewayError('not_found', 'quoted_message_unknown');
  const status = disconnectCode(e);
  if (status !== undefined) {
    if (status === 400) return gatewayError('invalid_input', 'wa_400');
    if (status === 401) return gatewayError('needs_relink', 'wa_401');
    if (status === 403) return gatewayError('forbidden_chat', 'wa_403');
    if (status === 404) return gatewayError('invalid_number', 'wa_404');
    if (status === 408) return gatewayError('timeout', 'wa_408');
    if (status === 413) return gatewayError('media_too_large', 'wa_413');
    if (status === 428) return gatewayError('session_disconnected', 'wa_428');
    if (status === 429) return gatewayError('rate_limited', 'wa_429');
    if (status === 440) return gatewayError('conflict', 'wa_440');
    return gatewayError('provider_error', `wa_${status}`);
  }
  const errno = (e as { code?: unknown } | null)?.code;
  if (
    typeof errno === 'string' &&
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(errno)
  )
    return gatewayError('network', errno);
  return gatewayError('provider_error', e instanceof Error ? e.name : 'unknown');
}

function fail(error: GatewayError): SendResult {
  const r: SendResult = { ok: false, error: { code: error.code, transient: error.transient } };
  if (error.detail !== undefined) r.error!.detail = error.detail;
  return r;
}

function mediaContent(media: OutboundMedia, data: Buffer | { url: string }): AnyMessageContent {
  const caption = media.caption ? { caption: media.caption } : {};
  if (media.voice) return { audio: data, ptt: true, mimetype: media.mime };
  if (media.mime.startsWith('image/')) return { image: data, mimetype: media.mime, ...caption };
  if (media.mime.startsWith('video/')) return { video: data, mimetype: media.mime, ...caption };
  if (media.mime.startsWith('audio/')) return { audio: data, mimetype: media.mime };
  return {
    document: data,
    mimetype: media.mime,
    fileName: path.basename(media.storagePath),
    ...caption,
  };
}

export class BaileysProvider implements WhatsAppProvider {
  readonly kind = 'baileys' as const;
  readonly #sessions = new Map<string, { session: ProviderSession; off: () => void }>();
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #opts: BaileysProviderOptions;
  readonly #pacer: Pacer | null;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: Logger;

  constructor(opts: BaileysProviderOptions = {}) {
    this.#opts = opts;
    this.#pacer = opts.pacer === undefined ? new Pacer({}, { now: opts.now }) : opts.pacer;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#log = opts.logger ?? createLogger();
  }

  register(session: ProviderSession): void {
    this.unregister(session.accountId);
    const off = session.on((e) => {
      if (e.type === 'conflict')
        this.breaker(e.accountId).trip(e.code === 403 ? 'forbidden' : 'connection_replaced');
    });
    this.#sessions.set(session.accountId, { session, off });
  }

  unregister(accountId: string): void {
    this.#sessions.get(accountId)?.off();
    this.#sessions.delete(accountId);
  }

  session(accountId: string): ProviderSession | undefined {
    return this.#sessions.get(accountId)?.session;
  }

  breaker(accountId: string): CircuitBreaker {
    let b = this.#breakers.get(accountId);
    if (!b) {
      b = new CircuitBreaker(this.#opts.breaker, { now: this.#opts.now });
      this.#breakers.set(accountId, b);
    }
    return b;
  }

  capabilities(accountId: string): Capabilities {
    return this.#opts.capabilities?.(accountId) ?? BAILEYS_CAPABILITIES;
  }

  #openSession(accountId: string): ProviderSession {
    const s = this.session(accountId);
    if (!s) throw new BaileysProviderError(gatewayError('provider_unconfigured', 'no_session'));
    if (s.state !== 'open') throw new SessionNotOpenError(s.state);
    return s;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const log = this.#log.child({ account: hashId(msg.accountId) });
    try {
      const caps = this.capabilities(msg.accountId);

      // ---- capability + shape checks (never silently degrade, RL7)
      let content: AnyMessageContent | null = null;
      let deliveryMode: DeliveryMode = 'native';
      switch (msg.kind) {
        case 'template':
          // WhatsApp Web has no approved-template concept; never sent as plain text silently.
          return fail(gatewayError('capability_unsupported', 'templates'));
        case 'text':
          if (!msg.text?.trim()) return fail(gatewayError('invalid_input', 'empty_text'));
          content = { text: msg.text };
          deliveryMode = 'text';
          break;
        case 'interactive': {
          const it = msg.interactive;
          if (!it?.body?.trim() || !it.options.length)
            return fail(gatewayError('invalid_input', 'empty_interactive'));
          const max = it.style === 'buttons' ? MAX_BUTTONS : MAX_LIST_ROWS;
          if (it.options.length > max)
            return fail(gatewayError('invalid_input', `too_many_options:${max}`));
          // Native buttons/lists are not sent on personal accounts: numbered text, visibly.
          content = { text: renderNumberedText(it.body, it.options) };
          deliveryMode = 'fallback';
          break;
        }
        case 'media':
          if (!msg.media) return fail(gatewayError('invalid_input', 'missing_media'));
          if (!caps.media) return fail(gatewayError('capability_unsupported', 'media'));
          if (msg.media.voice && !caps.voiceNotes)
            return fail(gatewayError('capability_unsupported', 'voice_notes'));
          if (!this.#opts.resolveMedia)
            return fail(gatewayError('provider_unconfigured', 'media_resolver'));
          break;
        case 'reaction':
          if (!msg.reaction?.targetProviderId)
            return fail(gatewayError('invalid_input', 'missing_reaction'));
          if (!caps.reactions) return fail(gatewayError('capability_unsupported', 'reactions'));
          break;
      }

      const target = normalizeJid(msg.to);
      if (!target.ok) return fail(target.error);
      const jid = target.value.jid;
      if (target.value.kind === 'group' && caps.groups !== 'full')
        return fail(gatewayError('capability_unsupported', 'groups'));
      if (target.value.kind === 'status')
        return fail(gatewayError('capability_unsupported', 'status_send'));

      const session = this.#openSession(msg.accountId);

      // ---- circuit breaker
      const br = this.breaker(msg.accountId).state();
      if (br.open) {
        if (br.reason === 'failure_spike')
          return fail(
            gatewayError('rate_limited', 'circuit_open', {
              retryAfterMs: Math.max(0, (br.until ?? 0) - (this.#opts.now ?? Date.now)()),
            }),
          );
        return fail(gatewayError('conflict', `circuit_open:${br.reason}`, { transient: false }));
      }

      // ---- pacing
      if (this.#pacer) {
        const d = this.#pacer.reserve(msg.accountId, jid);
        if (!d.ok)
          return fail(gatewayError('rate_limited', d.reason, { retryAfterMs: d.retryAfterMs }));
        const maxInline = this.#opts.maxInlineWaitMs ?? 30_000;
        if (d.waitMs > maxInline)
          return fail(gatewayError('rate_limited', 'pacing', { retryAfterMs: d.waitMs }));
        const typing =
          (this.#opts.typingIndicator ?? true) &&
          caps.typingPresence &&
          (msg.kind === 'text' || msg.kind === 'interactive');
        if (typing) await session.presence(jid, 'composing').catch(() => undefined);
        await this.#sleep(d.waitMs);
        if (typing) await session.presence(jid, 'paused').catch(() => undefined);
      }

      // ---- send
      let sent: { id: string };
      if (msg.kind === 'reaction') {
        sent = await session.react(jid, msg.reaction!.targetProviderId, msg.reaction!.emoji);
      } else {
        if (msg.kind === 'media') {
          const data = await this.#opts.resolveMedia!(msg.media!, msg.accountId);
          content = mediaContent(msg.media!, data);
        }
        const o: { quotedId?: string } = {};
        if (msg.quotedProviderId) o.quotedId = msg.quotedProviderId;
        sent = await session.sendMessage(jid, content!, o);
      }
      this.breaker(msg.accountId).recordSuccess();
      log.info({ kind: msg.kind, deliveryMode, chat: hashId(jid) }, 'send_ok');
      return { ok: true, providerMessageId: sent.id, deliveryMode };
    } catch (e) {
      const ge = mapBaileysError(e);
      if (ge.transient && ge.code !== 'session_disconnected') {
        if (this.breaker(msg.accountId).recordFailure())
          log.error({ code: ge.code }, 'circuit_breaker_tripped');
      }
      log.warn({ kind: msg.kind, code: ge.code, detail: ge.detail ?? null }, 'send_failed');
      return fail(ge);
    }
  }

  async markRead(accountId: string, chat: string, ids: string[]): Promise<void> {
    const target = normalizeJid(chat);
    if (!target.ok) throw new BaileysProviderError(target.error);
    try {
      await this.#openSession(accountId).markRead(target.value.jid, ids);
    } catch (e) {
      throw new BaileysProviderError(mapBaileysError(e));
    }
  }

  async setPresence(accountId: string, chat: string, p: Presence): Promise<void> {
    const target = normalizeJid(chat);
    if (!target.ok) throw new BaileysProviderError(target.error);
    try {
      await this.#openSession(accountId).presence(target.value.jid, p);
    } catch (e) {
      throw new BaileysProviderError(mapBaileysError(e));
    }
  }

  async status(accountId: string): Promise<SessionHealth> {
    const s = this.session(accountId);
    if (s) return s.health();
    return {
      accountId,
      provider: 'baileys',
      connection: 'unconfigured',
      connectedAt: null,
      lastHeartbeatAt: null,
      lastErrorCode: null,
    };
  }
}
