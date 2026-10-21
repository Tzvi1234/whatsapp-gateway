import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  err,
  gatewayError,
  normalizeJid,
  ok,
  shouldAdvanceStatus,
  type GatewayErrorCode,
  type InboundEvent,
  type InboundType,
  type MessageStatus,
  type Result,
} from '@htz/core';
import { mapGraphErrorCode } from './graph-client';

/* ------------------------------------------------------------------------------------------ */
/* Signature (S1)                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

export type SignatureFailure =
  'missing_header' | 'malformed_header' | 'missing_secret' | 'bad_signature';

/**
 * Verifies `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(appSecret, EXACT raw bytes).
 * Must be called on the raw request bytes (`await req.arrayBuffer()`) BEFORE JSON parsing;
 * a re-serialised body will not match. Constant-time comparison.
 */
export function verifyMetaSignature(
  rawBody: Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): Result<void> {
  const fail = (reason: SignatureFailure) => err(gatewayError('unauthorized', reason));
  if (!appSecret) return fail('missing_secret');
  if (!header) return fail('missing_header');
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return fail('malformed_header');
  const given = Buffer.from(m[1]!.toLowerCase(), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return fail('bad_signature');
  }
  return ok(undefined);
}

/* ------------------------------------------------------------------------------------------ */
/* GET hub challenge (S2)                                                                      */
/* ------------------------------------------------------------------------------------------ */

export type VerifyChallengeResult =
  { status: 200; body: string } | { status: 403; body: 'forbidden' };

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `GET /api/meta/webhook?hub.mode=subscribe&hub.verify_token=..&hub.challenge=..` */
export function handleVerifyChallenge(
  params: URLSearchParams | Record<string, string | null | undefined>,
  verifyToken: string,
): VerifyChallengeResult {
  const get = (k: string): string | null =>
    params instanceof URLSearchParams ? params.get(k) : (params[k] ?? null);
  const mode = get('hub.mode');
  const token = get('hub.verify_token');
  const challenge = get('hub.challenge');
  if (
    !verifyToken ||
    mode !== 'subscribe' ||
    !token ||
    !challenge ||
    challenge.length > 256 ||
    !safeEqualString(token, verifyToken)
  ) {
    return { status: 403, body: 'forbidden' };
  }
  return { status: 200, body: challenge };
}

/* ------------------------------------------------------------------------------------------ */
/* Payload parsing (§4.3)                                                                      */
/* ------------------------------------------------------------------------------------------ */

const mediaObj = z.object({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

const messageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: mediaObj.optional(),
  video: mediaObj.optional(),
  audio: mediaObj.optional(),
  document: mediaObj.optional(),
  sticker: mediaObj.optional(),
  location: z.object({}).loose().optional(),
  contacts: z.array(z.object({}).loose()).optional(),
  reaction: z
    .object({ message_id: z.string().optional(), emoji: z.string().optional() })
    .optional(),
  button: z.object({ text: z.string().optional(), payload: z.string().optional() }).optional(),
  interactive: z
    .object({
      type: z.string().optional(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  context: z
    .object({
      id: z.string().optional(),
      from: z.string().optional(),
      forwarded: z.boolean().optional(),
      frequently_forwarded: z.boolean().optional(),
    })
    .optional(),
});

const statusSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().regex(/^\d+$/),
  recipient_id: z.string().optional(),
  errors: z.array(z.object({ code: z.number().optional() }).loose()).optional(),
});

const valueSchema = z.object({
  messaging_product: z.literal('whatsapp').optional(),
  metadata: z.object({
    phone_number_id: z.string().min(1),
    display_phone_number: z.string().optional(),
  }),
  contacts: z
    .array(
      z.object({
        wa_id: z.string().optional(),
        profile: z.object({ name: z.string() }).optional(),
      }),
    )
    .optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const webhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

export interface ParsedInbound {
  dedupeKey: string;
  phoneNumberId: string;
  event: InboundEvent;
  /** Graph media id to download (`GET /{media_id}`), when the message carries media. */
  mediaId: string | null;
}

export interface StatusUpdate {
  dedupeKey: string;
  accountId: string;
  phoneNumberId: string;
  providerMessageId: string;
  status: Extract<MessageStatus, 'sent' | 'delivered' | 'read' | 'failed'>;
  timestamp: string;
  errorCode: GatewayErrorCode | null;
}

export type RejectReason = 'too_old' | 'unknown_phone_number' | 'malformed' | 'unsupported_field';

export interface RejectedItem {
  dedupeKey: string | null;
  reason: RejectReason;
}

export interface ParsedWebhook {
  inbound: ParsedInbound[];
  statuses: StatusUpdate[];
  rejected: RejectedItem[];
}

export interface ParseWebhookOptions {
  /** Maps Meta `phone_number_id` → Gateway account id; `null` rejects the item. */
  accountIdFor: (phoneNumberId: string) => string | null;
  now?: Date;
  /** Items older than this are rejected as replays (S1). Default 24h. */
  maxAgeMs?: number;
}

export const WEBHOOK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const dedupeKeys = {
  message: (id: string) => `meta:msg:${id}`,
  status: (id: string, status: string) => `meta:status:${id}:${status}`,
};

function inboundType(type: string, voice: boolean): InboundType {
  switch (type) {
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return voice ? 'voice' : 'audio';
    case 'document':
      return 'document';
    case 'sticker':
      return 'sticker';
    case 'location':
      return 'location';
    case 'contacts':
      return 'contact';
    case 'reaction':
      return 'reaction';
    case 'interactive':
    case 'button':
      return 'interactive_reply';
    default:
      return 'unknown';
  }
}

function pnJid(waId: string): string | null {
  const j = normalizeJid(waId);
  if (j.ok && j.value.kind === 'pn') return j.value.jid;
  return /^\d{6,15}$/.test(waId) ? `${waId}@s.whatsapp.net` : null;
}

const STATUS_MAP: Record<string, StatusUpdate['status']> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/**
 * Normalises a verified Meta webhook JSON into inbound events + status updates with
 * dedupe keys. Never throws; malformed or replayed (>24h) items are reported in `rejected`.
 */
export function parseWebhook(json: unknown, opts: ParseWebhookOptions): Result<ParsedWebhook> {
  const root = webhookSchema.safeParse(json);
  if (!root.success) return err(gatewayError('invalid_input', 'not_a_whatsapp_webhook'));
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxAge = opts.maxAgeMs ?? WEBHOOK_MAX_AGE_MS;
  const out: ParsedWebhook = { inbound: [], statuses: [], rejected: [] };

  for (const entry of root.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        out.rejected.push({ dedupeKey: null, reason: 'unsupported_field' });
        continue;
      }
      const value = valueSchema.safeParse(change.value);
      if (!value.success) {
        out.rejected.push({ dedupeKey: null, reason: 'malformed' });
        continue;
      }
      const phoneNumberId = value.data.metadata.phone_number_id;
      const accountId = opts.accountIdFor(phoneNumberId);
      const names = new Map<string, string>();
      for (const c of value.data.contacts ?? []) {
        if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
      }

      for (const raw of value.data.messages ?? []) {
        const m = messageSchema.safeParse(raw);
        if (!m.success) {
          out.rejected.push({ dedupeKey: null, reason: 'malformed' });
          continue;
        }
        const msg = m.data;
        const dedupeKey = dedupeKeys.message(msg.id);
        const tsMs = Number(msg.timestamp) * 1000;
        if (nowMs - tsMs > maxAge) {
          out.rejected.push({ dedupeKey, reason: 'too_old' });
          continue;
        }
        if (!accountId) {
          out.rejected.push({ dedupeKey, reason: 'unknown_phone_number' });
          continue;
        }
        const sender = pnJid(msg.from);
        if (!sender) {
          out.rejected.push({ dedupeKey, reason: 'malformed' });
          continue;
        }
        const media =
          msg.type === 'image' ||
          msg.type === 'video' ||
          msg.type === 'audio' ||
          msg.type === 'document' ||
          msg.type === 'sticker'
            ? msg[msg.type]
            : undefined;
        const type = inboundType(msg.type, media?.voice === true);
        let text: string | null = null;
        if (msg.text) text = msg.text.body;
        else if (media?.caption) text = media.caption;
        else if (msg.interactive?.button_reply) text = msg.interactive.button_reply.title;
        else if (msg.interactive?.list_reply) text = msg.interactive.list_reply.title;
        else if (msg.button?.text) text = msg.button.text;
        else if (msg.reaction?.emoji) text = msg.reaction.emoji;

        const quoted = msg.reaction?.message_id ?? msg.context?.id ?? null;
        const event: InboundEvent = {
          accountId,
          provider: 'meta_cloud',
          providerMessageId: msg.id,
          chat: sender,
          senderPn: sender,
          senderLid: null,
          isGroup: false,
          fromMe: false,
          type,
          text,
          pushName: names.get(msg.from) ?? null,
          timestamp: new Date(tsMs).toISOString(),
          isForwarded: Boolean(msg.context?.forwarded || msg.context?.frequently_forwarded),
          quotedProviderId: quoted,
          media: media?.mime_type ? { mime: media.mime_type } : null,
          statusReplyToId: null,
        };
        out.inbound.push({ dedupeKey, phoneNumberId, event, mediaId: media?.id ?? null });
      }

      for (const raw of value.data.statuses ?? []) {
        const s = statusSchema.safeParse(raw);
        if (!s.success) {
          out.rejected.push({ dedupeKey: null, reason: 'malformed' });
          continue;
        }
        const st = s.data;
        const dedupeKey = dedupeKeys.status(st.id, st.status);
        const mapped = STATUS_MAP[st.status];
        if (!mapped) {
          out.rejected.push({ dedupeKey, reason: 'malformed' });
          continue;
        }
        const tsMs = Number(st.timestamp) * 1000;
        if (nowMs - tsMs > maxAge) {
          out.rejected.push({ dedupeKey, reason: 'too_old' });
          continue;
        }
        if (!accountId) {
          out.rejected.push({ dedupeKey, reason: 'unknown_phone_number' });
          continue;
        }
        const graphCode = st.errors?.[0]?.code;
        out.statuses.push({
          dedupeKey,
          accountId,
          phoneNumberId,
          providerMessageId: st.id,
          status: mapped,
          timestamp: new Date(tsMs).toISOString(),
          errorCode: mapped === 'failed' ? mapGraphErrorCode(graphCode) : null,
        });
      }
    }
  }
  return ok(out);
}

/* ------------------------------------------------------------------------------------------ */
/* Forward-only status ranking (R4.7)                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Applies one update to a current status; returns the status to persist (unchanged if stale). */
export function applyStatus(current: MessageStatus, next: MessageStatus): MessageStatus {
  return shouldAdvanceStatus(current, next) ? next : current;
}

/**
 * Folds a batch of (possibly out-of-order) updates per provider message id, starting from
 * the currently stored status. Returns only ids whose status actually advances.
 */
export function foldStatusUpdates(
  updates: readonly StatusUpdate[],
  current: (providerMessageId: string) => MessageStatus | undefined = () => undefined,
): Map<string, { status: MessageStatus; errorCode: GatewayErrorCode | null }> {
  const state = new Map<string, { status: MessageStatus; errorCode: GatewayErrorCode | null }>();
  const initial = new Map<string, MessageStatus>();
  for (const u of updates) {
    const prev = state.get(u.providerMessageId) ?? {
      status: current(u.providerMessageId) ?? 'queued',
      errorCode: null,
    };
    if (!initial.has(u.providerMessageId)) initial.set(u.providerMessageId, prev.status);
    if (shouldAdvanceStatus(prev.status, u.status)) {
      state.set(u.providerMessageId, { status: u.status, errorCode: u.errorCode });
    } else {
      state.set(u.providerMessageId, prev);
    }
  }
  for (const [id, v] of state) if (initial.get(id) === v.status) state.delete(id);
  return state;
}
