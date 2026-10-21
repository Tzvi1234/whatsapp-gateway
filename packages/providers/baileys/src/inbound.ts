/**
 * Pure mapping from Baileys 7.x `WAMessage` / `WAMessageUpdate` to the provider-neutral
 * `InboundEvent` / status updates (ARCH §4.4). No I/O, so it is unit-tested with fixtures.
 */
import {
  getContentType,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WAMessageContent,
  type WAMessageUpdate,
} from 'baileys';
import {
  jidKind,
  normalizeJid,
  type InboundEvent,
  type InboundType,
  type MessageStatus,
} from '@htz/core';

/** Own identity, so `fromMe` messages get a sender. */
export interface SelfIdentity {
  pn: string | null;
  lid: string | null;
}

function canonical(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const r = normalizeJid(jid);
  return r.ok ? r.value.jid : null;
}

function splitSender(
  primary: string | null | undefined,
  alt: string | null | undefined,
): { pn: string | null; lid: string | null } {
  let pn: string | null = null;
  let lid: string | null = null;
  for (const j of [primary, alt]) {
    const k = jidKind(j);
    if (k === 'pn' && !pn) pn = canonical(j);
    if (k === 'lid' && !lid) lid = canonical(j);
  }
  return { pn, lid };
}

export function toUnixSeconds(ts: WAMessage['messageTimestamp']): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') return ts;
  const n = typeof ts === 'object' && 'toNumber' in ts ? ts.toNumber() : Number(ts);
  return Number.isFinite(n) ? n : null;
}

/** Content types that carry no user-visible message (protocol noise). */
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
  'encEventResponseMessage',
  'pinInChatMessage',
  'callLogMesssage',
]);

function isViewOnce(msg: WAMessage): boolean {
  const m = msg.message;
  if (!m) return false;
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return true;
  if (msg.key.isViewOnce) return true;
  const c = normalizeMessageContent(m);
  return Boolean(
    c?.imageMessage?.viewOnce || c?.videoMessage?.viewOnce || c?.audioMessage?.viewOnce,
  );
}

interface Classified {
  type: InboundType;
  text: string | null;
  contextInfo: proto.IContextInfo | null | undefined;
  media: InboundEvent['media'];
  quotedOverride?: string | null;
}

function seconds(v: number | null | undefined): { seconds?: number } {
  return typeof v === 'number' && v > 0 ? { seconds: v } : {};
}

function classify(content: WAMessageContent): Classified | null {
  const ct = getContentType(content);
  if (!ct || IGNORED_TYPES.has(ct)) return null;
  switch (ct) {
    case 'conversation':
      return { type: 'text', text: content.conversation ?? '', contextInfo: null, media: null };
    case 'extendedTextMessage': {
      const m = content.extendedTextMessage!;
      return { type: 'text', text: m.text ?? '', contextInfo: m.contextInfo, media: null };
    }
    case 'imageMessage': {
      const m = content.imageMessage!;
      return {
        type: 'image',
        text: m.caption ?? null,
        contextInfo: m.contextInfo,
        media: { mime: m.mimetype ?? 'image/jpeg' },
      };
    }
    case 'videoMessage':
    case 'ptvMessage': {
      const m = (content.videoMessage ?? content.ptvMessage)!;
      return {
        type: 'video',
        text: m.caption ?? null,
        contextInfo: m.contextInfo,
        media: { mime: m.mimetype ?? 'video/mp4', ...seconds(m.seconds) },
      };
    }
    case 'audioMessage': {
      const m = content.audioMessage!;
      return {
        type: m.ptt ? 'voice' : 'audio',
        text: null,
        contextInfo: m.contextInfo,
        media: { mime: m.mimetype ?? 'audio/ogg; codecs=opus', ...seconds(m.seconds) },
      };
    }
    case 'documentMessage': {
      const m = content.documentMessage!;
      return {
        type: 'document',
        text: m.caption ?? null,
        contextInfo: m.contextInfo,
        media: { mime: m.mimetype ?? 'application/octet-stream' },
      };
    }
    case 'documentWithCaptionMessage': {
      const inner = content.documentWithCaptionMessage?.message;
      return inner ? classify(inner) : null;
    }
    case 'stickerMessage': {
      const m = content.stickerMessage!;
      return {
        type: 'sticker',
        text: null,
        contextInfo: m.contextInfo,
        media: { mime: m.mimetype ?? 'image/webp' },
      };
    }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const m = content.locationMessage ?? content.liveLocationMessage;
      return { type: 'location', text: null, contextInfo: m?.contextInfo, media: null };
    }
    case 'contactMessage':
    case 'contactsArrayMessage': {
      const m = content.contactMessage ?? content.contactsArrayMessage;
      return { type: 'contact', text: null, contextInfo: m?.contextInfo, media: null };
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5': {
      const m =
        content.pollCreationMessage ??
        content.pollCreationMessageV2 ??
        content.pollCreationMessageV3 ??
        content.pollCreationMessageV5;
      return { type: 'poll', text: m?.name ?? null, contextInfo: m?.contextInfo, media: null };
    }
    case 'reactionMessage': {
      const m = content.reactionMessage!;
      return {
        type: 'reaction',
        text: m.text ?? '',
        contextInfo: null,
        media: null,
        quotedOverride: m.key?.id ?? null,
      };
    }
    case 'buttonsResponseMessage': {
      const m = content.buttonsResponseMessage!;
      return {
        type: 'interactive_reply',
        text: m.selectedDisplayText ?? m.selectedButtonId ?? null,
        contextInfo: m.contextInfo,
        media: null,
      };
    }
    case 'listResponseMessage': {
      const m = content.listResponseMessage!;
      return {
        type: 'interactive_reply',
        text: m.title ?? m.singleSelectReply?.selectedRowId ?? null,
        contextInfo: m.contextInfo,
        media: null,
      };
    }
    case 'templateButtonReplyMessage': {
      const m = content.templateButtonReplyMessage!;
      return {
        type: 'interactive_reply',
        text: m.selectedDisplayText ?? m.selectedId ?? null,
        contextInfo: m.contextInfo,
        media: null,
      };
    }
    case 'interactiveResponseMessage': {
      const m = content.interactiveResponseMessage!;
      return {
        type: 'interactive_reply',
        text: m.body?.text ?? null,
        contextInfo: m.contextInfo,
        media: null,
      };
    }
    default:
      return { type: 'unknown', text: null, contextInfo: null, media: null };
  }
}

/**
 * Normalises one upserted message. Returns `null` for protocol/no-content messages and for
 * undecryptable stubs (see `isDecryptFailure`).
 */
export function normalizeInbound(
  msg: WAMessage,
  accountId: string,
  self: SelfIdentity = { pn: null, lid: null },
): InboundEvent | null {
  const key = msg.key;
  if (!key?.id || !key.remoteJid) return null;
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const cls = classify(content);
  if (!cls) return null;

  const rawChat = key.remoteJid;
  const chatKind = jidKind(rawChat);
  const chat = canonical(rawChat) ?? rawChat;
  const isGroup = chatKind === 'group';
  const fromMe = Boolean(key.fromMe);

  let sender: { pn: string | null; lid: string | null };
  if (fromMe) sender = { pn: self.pn, lid: self.lid };
  else if (isGroup || chatKind === 'status')
    sender = splitSender(key.participant, key.participantAlt);
  else sender = splitSender(rawChat, key.remoteJidAlt);

  const ctx = cls.contextInfo ?? null;
  const repliesToStatus = ctx?.remoteJid === 'status@broadcast' && Boolean(ctx.stanzaId);
  const quoted =
    cls.quotedOverride !== undefined
      ? cls.quotedOverride
      : repliesToStatus
        ? null
        : (ctx?.stanzaId ?? null);
  const ts = toUnixSeconds(msg.messageTimestamp);

  return {
    accountId,
    provider: 'baileys',
    providerMessageId: key.id,
    chat,
    senderPn: sender.pn,
    senderLid: sender.lid,
    isGroup,
    fromMe,
    type: isViewOnce(msg) ? 'view_once' : cls.type,
    text: cls.text,
    pushName: msg.pushName ?? null,
    timestamp: new Date((ts ?? 0) * 1000).toISOString(),
    isForwarded: Boolean(ctx?.isForwarded) || (ctx?.forwardingScore ?? 0) > 0,
    quotedProviderId: quoted,
    media: cls.media,
    statusReplyToId: repliesToStatus ? (ctx?.stanzaId ?? null) : null,
  };
}

/** A message Baileys could not decrypt arrives as a CIPHERTEXT stub without content. */
export function isDecryptFailure(msg: WAMessage): boolean {
  return msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && !msg.message;
}

const STATUS_MAP: Record<number, MessageStatus> = {
  [proto.WebMessageInfo.Status.ERROR]: 'failed',
  [proto.WebMessageInfo.Status.PENDING]: 'sending',
  [proto.WebMessageInfo.Status.SERVER_ACK]: 'sent',
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'delivered',
  [proto.WebMessageInfo.Status.READ]: 'read',
  [proto.WebMessageInfo.Status.PLAYED]: 'read',
};

export interface StatusUpdate {
  providerMessageId: string;
  chat: string;
  status: MessageStatus;
}

/** `messages.update` → delivery status of our own outgoing messages. */
export function mapStatusUpdate(u: WAMessageUpdate): StatusUpdate | null {
  const s = u.update.status;
  if (s === null || s === undefined || !u.key.id || !u.key.remoteJid || !u.key.fromMe) return null;
  const status = STATUS_MAP[s];
  if (!status) return null;
  return {
    providerMessageId: u.key.id,
    chat: canonical(u.key.remoteJid) ?? u.key.remoteJid,
    status,
  };
}
