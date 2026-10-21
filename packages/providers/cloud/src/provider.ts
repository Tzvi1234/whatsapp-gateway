import {
  CLOUD_CAPABILITIES,
  err,
  gatewayError,
  ok,
  type Capabilities,
  type GatewayError,
  type OutboundMessage,
  type Presence,
  type Result,
  type SendResult,
  type SessionHealth,
  type WhatsAppProvider,
} from '@htz/core';
import {
  GraphClient,
  type CloudCredentials,
  type GraphClientOptions,
  type GraphMediaSource,
  type GraphMediaType,
  type GraphSendOk,
} from './graph-client';

/** Resolves an account's Cloud credentials (from Vault, server-side). `null` = not configured. */
export type CredentialsResolver = (accountId: string) => Promise<CloudCredentials | null>;

/**
 * Resolves `OutboundMedia.storagePath` to something Graph can send: a public/signed
 * https link, or raw bytes that the provider uploads first (send by media id).
 */
export type MediaResolver = (
  accountId: string,
  storagePath: string,
) => Promise<Result<{ link: string } | { bytes: Uint8Array; filename?: string }>>;

export interface CloudApiProviderOptions {
  credentials: CredentialsResolver;
  resolveMedia?: MediaResolver;
  graph?: GraphClient;
  graphOptions?: GraphClientOptions;
  now?: () => Date;
}

/** Thrown by the void-returning interface methods (`markRead`) so failures are never silent. */
export class CloudProviderError extends Error {
  constructor(readonly error: GatewayError) {
    super(`cloud_provider_error:${error.code}`);
    this.name = 'CloudProviderError';
  }
}

export function mediaTypeForMime(mime: string, voice = false): GraphMediaType {
  const m = mime.toLowerCase();
  if (voice || m.startsWith('audio/')) return 'audio';
  if (m === 'image/webp') return 'sticker';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

function toSendResult(r: Result<GraphSendOk>): SendResult {
  if (r.ok) return { ok: true, providerMessageId: r.value.messageId, deliveryMode: 'native' };
  const e: { code: GatewayError['code']; transient: boolean; detail?: string } = {
    code: r.error.code,
    transient: r.error.transient,
  };
  if (r.error.detail !== undefined) e.detail = r.error.detail;
  return { ok: false, error: e };
}

/**
 * WhatsApp Cloud API provider (runs on Vercel). Stateless: credentials are resolved
 * per call, so adding credentials later makes `unconfigured` jobs succeed on retry (R4.4).
 */
export class CloudApiProvider implements WhatsAppProvider {
  readonly kind = 'meta_cloud' as const;
  private readonly graph: GraphClient;
  private readonly resolveCreds: CredentialsResolver;
  private readonly resolveMedia: MediaResolver | undefined;
  private readonly now: () => Date;

  constructor(opts: CloudApiProviderOptions) {
    this.graph = opts.graph ?? new GraphClient(opts.graphOptions);
    this.resolveCreds = opts.credentials;
    this.resolveMedia = opts.resolveMedia;
    this.now = opts.now ?? (() => new Date());
  }

  capabilities(_accountId: string): Capabilities {
    return CLOUD_CAPABILITIES;
  }

  private async creds(accountId: string): Promise<Result<CloudCredentials>> {
    let c: CloudCredentials | null;
    try {
      c = await this.resolveCreds(accountId);
    } catch {
      return err(gatewayError('internal', 'credentials_lookup_failed', { transient: true }));
    }
    if (!c || !c.phoneNumberId || !c.accessToken) {
      return err(gatewayError('provider_unconfigured', 'cloud_credentials_missing'));
    }
    return ok(c);
  }

  private async mediaSource(
    creds: CloudCredentials,
    accountId: string,
    storagePath: string,
    mime: string,
  ): Promise<Result<GraphMediaSource>> {
    if (storagePath.startsWith('graph-media:')) return ok({ id: storagePath.slice(12) });
    if (!this.resolveMedia) {
      if (/^https:\/\//i.test(storagePath)) return ok({ link: storagePath });
      return err(gatewayError('capability_unsupported', 'no_media_resolver'));
    }
    const m = await this.resolveMedia(accountId, storagePath);
    if (!m.ok) return m;
    if ('link' in m.value) return ok({ link: m.value.link });
    const up = await this.graph.uploadMedia(creds, m.value.bytes, mime, m.value.filename);
    if (!up.ok) return up;
    return ok({ id: up.value.id });
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const c = await this.creds(msg.accountId);
    if (!c.ok) return toSendResult(c);
    const creds = c.value;
    const replyOpts = msg.quotedProviderId ? { replyToId: msg.quotedProviderId } : {};

    switch (msg.kind) {
      case 'text': {
        if (!msg.text) return toSendResult(err(gatewayError('invalid_input', 'missing_text')));
        return toSendResult(await this.graph.sendText(creds, msg.to, msg.text, replyOpts));
      }
      case 'media': {
        if (!msg.media) return toSendResult(err(gatewayError('invalid_input', 'missing_media')));
        const src = await this.mediaSource(
          creds,
          msg.accountId,
          msg.media.storagePath,
          msg.media.mime,
        );
        if (!src.ok) return toSendResult(src);
        const media: Parameters<GraphClient['sendMedia']>[2] = {
          type: mediaTypeForMime(msg.media.mime, msg.media.voice),
          source: src.value,
        };
        if (msg.media.caption) media.caption = msg.media.caption;
        return toSendResult(await this.graph.sendMedia(creds, msg.to, media, replyOpts));
      }
      case 'template': {
        if (!msg.template) {
          return toSendResult(err(gatewayError('invalid_input', 'missing_template')));
        }
        return toSendResult(
          await this.graph.sendTemplate(creds, msg.to, {
            name: msg.template.name,
            language: msg.template.language,
            bodyParams: msg.template.params,
          }),
        );
      }
      case 'interactive': {
        if (!msg.interactive) {
          return toSendResult(err(gatewayError('invalid_input', 'missing_interactive')));
        }
        return toSendResult(
          await this.graph.sendInteractive(creds, msg.to, msg.interactive, replyOpts),
        );
      }
      case 'reaction': {
        if (!msg.reaction) {
          return toSendResult(err(gatewayError('invalid_input', 'missing_reaction')));
        }
        return toSendResult(
          await this.graph.sendReaction(
            creds,
            msg.to,
            msg.reaction.targetProviderId,
            msg.reaction.emoji,
          ),
        );
      }
    }
  }

  /** Result-returning read receipt (optionally with typing indicator). */
  async readReceipt(
    accountId: string,
    providerMessageId: string,
    opts: { typing?: boolean } = {},
  ): Promise<Result<void>> {
    const c = await this.creds(accountId);
    if (!c.ok) return c;
    return this.graph.markRead(c.value, providerMessageId, opts);
  }

  /** Graph marks read per inbound message id; the `chat` argument is not needed. */
  async markRead(accountId: string, _chat: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = await this.readReceipt(accountId, id);
      if (!r.ok) throw new CloudProviderError(r.error);
    }
  }

  /**
   * Graph has no chat-level presence: the typing indicator is tied to an inbound
   * message id (use `showTyping`). This is a no-op kept for interface parity.
   */
  async setPresence(_accountId: string, _chat: string, _p: Presence): Promise<void> {}

  /** Shows "typing…" in reply to `inboundMessageId` (also marks it read, Graph semantics). */
  showTyping(accountId: string, inboundMessageId: string): Promise<Result<void>> {
    return this.readReceipt(accountId, inboundMessageId, { typing: true });
  }

  /** Never returns secrets. `unconfigured` when no credentials exist (legacy reminders state). */
  async status(accountId: string): Promise<SessionHealth> {
    const base: SessionHealth = {
      accountId,
      provider: 'meta_cloud',
      connection: 'unconfigured',
      connectedAt: null,
      lastHeartbeatAt: null,
      lastErrorCode: null,
    };
    const c = await this.creds(accountId);
    if (!c.ok) {
      return {
        ...base,
        lastErrorCode: c.error.code === 'provider_unconfigured' ? null : c.error.code,
      };
    }
    const r = await this.graph.request<{ id?: string }>(
      'GET',
      encodeURIComponent(c.value.phoneNumberId),
      c.value.accessToken,
      { query: { fields: 'id' } },
    );
    const at = this.now().toISOString();
    if (r.ok) return { ...base, connection: 'open', lastHeartbeatAt: at };
    return { ...base, connection: 'closed', lastHeartbeatAt: at, lastErrorCode: r.error.code };
  }
}
