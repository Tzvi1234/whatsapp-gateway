import {
  err,
  gatewayError,
  normalizeJid,
  ok,
  type GatewayError,
  type GatewayErrorCode,
  type Result,
} from '@htz/core';

/**
 * Meta Graph API client (server-only). The access token travels only in the
 * `Authorization` header: it is never put in a URL, a log line, an error detail
 * or a return value.
 */

/** Pinned Graph API version. Override per client via `GraphClientOptions.version`. */
export const GRAPH_VERSION = 'v23.0';
export const GRAPH_BASE_URL = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_TIMEOUT_MS = 15_000;

/** Interactive limits enforced by Meta. */
export const MAX_REPLY_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
export const MAX_BUTTON_TITLE = 20;
export const MAX_LIST_ROW_TITLE = 24;
export const MAX_LIST_ROW_DESCRIPTION = 72;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  fetch?: FetchLike;
  version?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Credentials for one Cloud API phone number. Never logged. */
export interface CloudCredentials {
  phoneNumberId: string;
  accessToken: string;
}

export type GraphMediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export type GraphMediaSource = { link: string } | { id: string };

export interface GraphMediaMessage {
  type: GraphMediaType;
  source: GraphMediaSource;
  caption?: string;
  filename?: string;
}

export interface GraphTemplateMessage {
  name: string;
  language: string;
  bodyParams: readonly string[];
}

export interface GraphInteractiveMessage {
  style: 'buttons' | 'list';
  body: string;
  options: readonly string[];
  /** List-only: label of the button that opens the list (max 20 chars). */
  buttonText?: string;
  header?: string;
  footer?: string;
}

export interface GraphSendOk {
  messageId: string;
}

interface GraphErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    type?: string;
    message?: string;
  };
}

interface CodeMapping {
  code: GatewayErrorCode;
  transient: boolean;
}

/** Graph / WhatsApp Cloud API error codes → Gateway codes. */
const GRAPH_CODE_MAP: Readonly<Record<number, CodeMapping>> = {
  // auth / permissions
  190: { code: 'invalid_credentials', transient: false },
  10: { code: 'invalid_credentials', transient: false },
  200: { code: 'invalid_credentials', transient: false },
  131031: { code: 'invalid_credentials', transient: false },
  133010: { code: 'provider_unconfigured', transient: false },
  // throttling
  4: { code: 'rate_limited', transient: true },
  80007: { code: 'rate_limited', transient: true },
  130429: { code: 'rate_limited', transient: true },
  131048: { code: 'rate_limited', transient: true },
  131056: { code: 'rate_limited', transient: true },
  // Meta-side transient failures
  1: { code: 'provider_error', transient: true },
  2: { code: 'provider_error', transient: true },
  131000: { code: 'provider_error', transient: true },
  131016: { code: 'provider_error', transient: true },
  // policy / window
  131047: { code: 'outside_24h_window', transient: false },
  // recipient
  131026: { code: 'invalid_number', transient: false },
  131030: { code: 'invalid_number', transient: false },
  // templates
  132001: { code: 'template_not_found', transient: false },
  132016: { code: 'template_not_found', transient: false },
  132000: { code: 'invalid_input', transient: false },
  132005: { code: 'invalid_input', transient: false },
  132012: { code: 'invalid_input', transient: false },
  // payload
  100: { code: 'invalid_input', transient: false },
  131008: { code: 'invalid_input', transient: false },
  131009: { code: 'invalid_input', transient: false },
  131021: { code: 'invalid_input', transient: false },
  131051: { code: 'capability_unsupported', transient: false },
  // media
  131052: { code: 'provider_error', transient: false },
  131053: { code: 'provider_error', transient: false },
  // account restricted by Meta
  368: { code: 'provider_error', transient: false },
};

/** Map a Graph error code (e.g. from a webhook `statuses[].errors[]`) to a Gateway code. */
export function mapGraphErrorCode(graphCode: number | undefined): GatewayErrorCode {
  if (graphCode === undefined) return 'provider_error';
  return GRAPH_CODE_MAP[graphCode]?.code ?? 'provider_error';
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const v = headers?.get('retry-after');
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * Classify a non-2xx Graph response. The detail is a stable token
 * (`graph_<status>_<code>[_<subcode>]`); Graph's free-text message is never copied.
 */
export function classifyGraphError(status: number, body: unknown, headers?: Headers): GatewayError {
  const e = (body as GraphErrorBody | null)?.error;
  const code = typeof e?.code === 'number' ? e.code : undefined;
  const sub = typeof e?.error_subcode === 'number' ? e.error_subcode : undefined;
  const detail = `graph_${status}${code !== undefined ? `_${code}` : ''}${sub !== undefined ? `_${sub}` : ''}`;
  const retryAfterMs = parseRetryAfterMs(headers);
  const extra = (transient: boolean) =>
    retryAfterMs !== undefined ? { transient, retryAfterMs } : { transient };

  const mapped = code !== undefined ? GRAPH_CODE_MAP[code] : undefined;
  if (status === 429) return gatewayError('rate_limited', detail, extra(true));
  if (mapped && !(status >= 500 && !mapped.transient)) {
    return gatewayError(mapped.code, detail, extra(mapped.transient));
  }
  if (status >= 500) return gatewayError('provider_error', detail, extra(true));
  if (status === 401) return gatewayError('invalid_credentials', detail, extra(false));
  return gatewayError('provider_error', detail, extra(false));
}

/** Graph wants recipients as digits without `+`. Accepts E.164, IL local numbers or PN JIDs. */
export function toGraphRecipient(to: string): Result<string> {
  const j = normalizeJid(to);
  if (!j.ok) return j;
  if (j.value.kind !== 'pn' || !j.value.e164) {
    return err(gatewayError('capability_unsupported', 'cloud_api_requires_phone_recipient'));
  }
  return ok(j.value.e164.slice(1));
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    ((e as { name: string }).name === 'TimeoutError' ||
      (e as { name: string }).name === 'AbortError')
  );
}

export interface GraphRequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
}

export class GraphClient {
  readonly version: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: GraphClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.version = opts.version ?? GRAPH_VERSION;
    this.baseUrl = (opts.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;
  }

  /** Low-level call. `path` must not contain secrets; the token goes only in the header. */
  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    accessToken: string,
    opts: GraphRequestOptions = {},
  ): Promise<Result<T>> {
    const url = new URL(`${this.baseUrl}/${this.version}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    let body: string | FormData | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }

    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) init.body = body;
      res = await this.fetchImpl(url.toString(), init);
    } catch (e) {
      return err(
        isAbortError(e)
          ? gatewayError('timeout', 'graph_timeout')
          : gatewayError('network', 'graph_network_error'),
      );
    }

    let parsed: unknown;
    try {
      const text = await res.text();
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) return err(classifyGraphError(res.status, parsed, res.headers));
    if (parsed === null || typeof parsed !== 'object') {
      return err(gatewayError('provider_error', 'graph_unparseable_response', { transient: true }));
    }
    return ok(parsed as T);
  }

  private async sendMessage(
    creds: CloudCredentials,
    to: string,
    payload: Record<string, unknown>,
    replyToId?: string,
  ): Promise<Result<GraphSendOk>> {
    const recipient = toGraphRecipient(to);
    if (!recipient.ok) return recipient;
    const json: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient.value,
      ...payload,
    };
    if (replyToId) json.context = { message_id: replyToId };
    const r = await this.request<{ messages?: { id?: string }[] }>(
      'POST',
      `${encodeURIComponent(creds.phoneNumberId)}/messages`,
      creds.accessToken,
      { json },
    );
    if (!r.ok) return r;
    const id = r.value.messages?.[0]?.id;
    if (!id) return err(gatewayError('provider_error', 'graph_missing_message_id'));
    return ok({ messageId: id });
  }

  sendText(
    creds: CloudCredentials,
    to: string,
    text: string,
    opts: { replyToId?: string; previewUrl?: boolean } = {},
  ): Promise<Result<GraphSendOk>> {
    return this.sendMessage(
      creds,
      to,
      { type: 'text', text: { body: text, preview_url: opts.previewUrl ?? false } },
      opts.replyToId,
    );
  }

  sendMedia(
    creds: CloudCredentials,
    to: string,
    media: GraphMediaMessage,
    opts: { replyToId?: string } = {},
  ): Promise<Result<GraphSendOk>> {
    const obj: Record<string, unknown> =
      'id' in media.source ? { id: media.source.id } : { link: media.source.link };
    if (media.caption && media.type !== 'audio' && media.type !== 'sticker') {
      obj.caption = media.caption;
    }
    if (media.filename && media.type === 'document') obj.filename = media.filename;
    return this.sendMessage(creds, to, { type: media.type, [media.type]: obj }, opts.replyToId);
  }

  sendTemplate(
    creds: CloudCredentials,
    to: string,
    tpl: GraphTemplateMessage,
  ): Promise<Result<GraphSendOk>> {
    const template: Record<string, unknown> = {
      name: tpl.name,
      language: { code: tpl.language },
    };
    if (tpl.bodyParams.length > 0) {
      template.components = [
        {
          type: 'body',
          parameters: tpl.bodyParams.map((p) => ({ type: 'text', text: p })),
        },
      ];
    }
    return this.sendMessage(creds, to, { type: 'template', template });
  }

  async sendInteractive(
    creds: CloudCredentials,
    to: string,
    msg: GraphInteractiveMessage,
    opts: { replyToId?: string } = {},
  ): Promise<Result<GraphSendOk>> {
    const built = buildInteractive(msg);
    if (!built.ok) return built;
    return this.sendMessage(
      creds,
      to,
      { type: 'interactive', interactive: built.value },
      opts.replyToId,
    );
  }

  sendReaction(
    creds: CloudCredentials,
    to: string,
    targetMessageId: string,
    emoji: string,
  ): Promise<Result<GraphSendOk>> {
    return this.sendMessage(creds, to, {
      type: 'reaction',
      reaction: { message_id: targetMessageId, emoji },
    });
  }

  /** Marks an inbound message read; with `typing: true` also shows the typing indicator (≤25s). */
  async markRead(
    creds: CloudCredentials,
    messageId: string,
    opts: { typing?: boolean } = {},
  ): Promise<Result<void>> {
    const json: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };
    if (opts.typing) json.typing_indicator = { type: 'text' };
    const r = await this.request<{ success?: boolean }>(
      'POST',
      `${encodeURIComponent(creds.phoneNumberId)}/messages`,
      creds.accessToken,
      { json },
    );
    if (!r.ok) return r;
    return ok(undefined);
  }

  /** Uploads media and returns the Graph media id to send by id. */
  async uploadMedia(
    creds: CloudCredentials,
    bytes: Uint8Array,
    mime: string,
    filename = 'file',
  ): Promise<Result<{ id: string }>> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mime);
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const r = await this.request<{ id?: string }>(
      'POST',
      `${encodeURIComponent(creds.phoneNumberId)}/media`,
      creds.accessToken,
      { form },
    );
    if (!r.ok) return r;
    if (!r.value.id) return err(gatewayError('provider_error', 'graph_missing_media_id'));
    return ok({ id: r.value.id });
  }
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

/** Builds the Graph `interactive` object, enforcing Meta's limits (≤3 buttons, ≤10 rows). */
export function buildInteractive(msg: GraphInteractiveMessage): Result<Record<string, unknown>> {
  if (msg.body.trim().length === 0)
    return err(gatewayError('invalid_input', 'interactive_empty_body'));
  if (msg.options.length === 0) return err(gatewayError('invalid_input', 'interactive_no_options'));
  const extras: Record<string, unknown> = {};
  if (msg.header) extras.header = { type: 'text', text: msg.header };
  if (msg.footer) extras.footer = { text: msg.footer };

  if (msg.style === 'buttons') {
    if (msg.options.length > MAX_REPLY_BUTTONS) {
      return err(gatewayError('invalid_input', 'too_many_buttons'));
    }
    if (msg.options.some((o) => [...o].length > MAX_BUTTON_TITLE || o.trim().length === 0)) {
      return err(gatewayError('invalid_input', 'button_title_length'));
    }
    return ok({
      type: 'button',
      body: { text: msg.body },
      ...extras,
      action: {
        buttons: msg.options.map((title, i) => ({
          type: 'reply',
          reply: { id: `opt_${i + 1}`, title },
        })),
      },
    });
  }

  if (msg.options.length > MAX_LIST_ROWS) {
    return err(gatewayError('invalid_input', 'too_many_list_rows'));
  }
  return ok({
    type: 'list',
    body: { text: msg.body },
    ...extras,
    action: {
      button: truncate(msg.buttonText ?? 'בחירה', MAX_BUTTON_TITLE),
      sections: [
        {
          title: truncate(msg.header ?? 'אפשרויות', MAX_LIST_ROW_TITLE),
          rows: msg.options.map((o, i) => {
            const row: Record<string, unknown> = {
              id: `opt_${i + 1}`,
              title: truncate(o, MAX_LIST_ROW_TITLE),
            };
            if ([...o].length > MAX_LIST_ROW_TITLE) {
              row.description = truncate(o, MAX_LIST_ROW_DESCRIPTION);
            }
            return row;
          }),
        },
      ],
    },
  });
}
