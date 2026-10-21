import { randomUUID } from 'node:crypto';
import type {
  InboundType,
  RelayBatchPayload,
  RelayMessage,
  RelayMessageType,
  RelayTranscriptEvent,
} from '@htz/core';

/** Fixed Hebrew copy the Gateway itself sends (ARCH §4.7). */
export const UNSUPPORTED_REPLY_TEXT = 'סוג הודעה זה עדיין לא נתמך';
export const VOICE_ACK_TEXT = 'קיבלתי הקלטה, מתמלל';

/** Inbound types that get the explicit "not supported" reply and are never relayed (L1.8). */
export const UNSUPPORTED_INBOUND_TYPES: readonly InboundType[] = [
  'sticker',
  'location',
  'contact',
  'poll',
  'view_once',
  'unknown',
];

/** What the worker feeds into the relay module for one allowlisted inbound message. */
export interface RelayInboundMessage {
  messageId: string;
  /** Conversation / chat key the debounce timer is per. */
  threadId: string;
  /** Sender E.164 (already matched by the sender allowlist). */
  from: string;
  timestamp: string;
  type: InboundType;
  text: string | null;
  /** Short-lived signed URL (≤15 min) for media, else null. */
  mediaUrl: string | null;
  replyToId: string | null;
  isForwarded: boolean;
  /** Voice duration in seconds when known. */
  voiceSeconds?: number | null;
  /** Present (string or null) when the transcript is already final, e.g. on recovery. */
  transcript?: string | null;
}

export type RelayRouting = { relay: RelayMessageType } | { unsupported: true } | { ignored: true };

/** Map a normalised inbound type to the relay contract type. */
export function routeInboundType(t: InboundType): RelayRouting {
  switch (t) {
    case 'text':
    case 'interactive_reply':
      return { relay: 'text' };
    case 'image':
    case 'video':
    case 'audio':
    case 'voice':
    case 'document':
      return { relay: t };
    case 'reaction':
      // a reaction to Lia's message carries no request; not relayed, not answered
      return { ignored: true };
    default:
      return { unsupported: true };
  }
}

export function newBatchId(): string {
  return randomUUID();
}

/** Build one contract `RelayMessage` with exactly the contract fields (L3.10). */
export function toRelayMessage(m: RelayInboundMessage, transcript: string | null): RelayMessage {
  const route = routeInboundType(m.type);
  return {
    message_id: m.messageId,
    from: m.from,
    timestamp: m.timestamp,
    type: 'relay' in route ? route.relay : 'unsupported',
    text: m.text,
    media_url: m.mediaUrl,
    transcript,
    reply_to_id: m.replyToId,
    is_forwarded: m.isForwarded,
  };
}

/**
 * Relay envelope per contracts/lia-connection-test.md. `batch_id` must be stable across
 * retries and "Resend to Lia" (L4.7/L4.8): pass the stored id, never mint a new one here.
 */
export function buildRelayPayload(input: {
  batchId: string;
  isTest: boolean;
  messages: readonly RelayMessage[];
}): RelayBatchPayload {
  if (!input.batchId) throw new Error('buildRelayPayload: batchId required');
  return {
    batch_id: input.batchId,
    is_test: input.isTest,
    messages: input.messages.map((m) => ({
      message_id: m.message_id,
      from: m.from,
      timestamp: m.timestamp,
      type: m.type,
      text: m.text,
      media_url: m.media_url,
      transcript: m.transcript,
      reply_to_id: m.reply_to_id,
      is_forwarded: m.is_forwarded,
    })),
  };
}

export function buildTranscriptEvent(
  batchId: string,
  messageId: string,
  transcript: string | null,
): RelayTranscriptEvent {
  return { event: 'transcript', batch_id: batchId, message_id: messageId, transcript };
}
