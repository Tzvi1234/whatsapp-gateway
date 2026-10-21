import type { GatewayErrorCode } from './errors';

export type ProviderKind = 'baileys' | 'meta_cloud';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unverified';

/** Persisted per account in accounts.capabilities (jsonb). */
export interface Capabilities {
  text: true;
  media: boolean;
  voiceNotes: boolean;
  reactions: boolean;
  templates: boolean;
  freeFormOutside24h: boolean;
  groups: 'full' | 'none';
  statusStories: boolean;
  nativeButtons: CapabilitySupport;
  lists: CapabilitySupport;
  readReceipts: boolean;
  typingPresence: boolean;
  initiateConversation: boolean;
}

export const BAILEYS_CAPABILITIES: Capabilities = {
  text: true,
  media: true,
  voiceNotes: true,
  reactions: true,
  templates: false,
  freeFormOutside24h: true,
  groups: 'full',
  statusStories: true,
  nativeButtons: 'unsupported',
  lists: 'unsupported',
  readReceipts: true,
  typingPresence: true,
  initiateConversation: true,
};

export const CLOUD_CAPABILITIES: Capabilities = {
  text: true,
  media: true,
  voiceNotes: true,
  reactions: true,
  templates: true,
  freeFormOutside24h: false,
  groups: 'none',
  statusStories: false,
  nativeButtons: 'supported',
  lists: 'supported',
  readReceipts: true,
  typingPresence: true,
  initiateConversation: true,
};

export const DEFAULT_CAPABILITIES: Record<ProviderKind, Capabilities> = {
  baileys: BAILEYS_CAPABILITIES,
  meta_cloud: CLOUD_CAPABILITIES,
};

export const USE_CASES = [
  'reminders',
  'notifications',
  'customer_service',
  'bookings',
  'agent_relay',
  'status_automation',
] as const;
export type UseCase = (typeof USE_CASES)[number];

export type OutboundKind = 'text' | 'media' | 'template' | 'reaction' | 'interactive';

export interface OutboundMedia {
  storagePath: string;
  mime: string;
  caption?: string;
  voice?: boolean;
}

export interface OutboundTemplate {
  name: string;
  language: string;
  params: string[];
}

export interface OutboundInteractive {
  body: string;
  /** Reply buttons (max 3) or list rows (max 10). Rendered as numbered text when unsupported. */
  options: string[];
  style: 'buttons' | 'list';
}

export interface OutboundMessage {
  accountId: string;
  /** E.164 or JID; normalised by the provider. */
  to: string;
  kind: OutboundKind;
  text?: string;
  media?: OutboundMedia;
  template?: OutboundTemplate;
  interactive?: OutboundInteractive;
  reaction?: { targetProviderId: string; emoji: string };
  quotedProviderId?: string;
  idempotencyKey: string;
  useCase: UseCase;
}

export type DeliveryMode = 'native' | 'fallback' | 'text';

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  deliveryMode?: DeliveryMode;
  error?: { code: GatewayErrorCode; transient: boolean; detail?: string };
}

export type ConnectionState =
  'connecting' | 'open' | 'closed' | 'needs_relink' | 'conflict' | 'unconfigured' | 'paused';

export interface SessionHealth {
  accountId: string;
  provider: ProviderKind;
  connection: ConnectionState;
  connectedAt: string | null;
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
}

export type Presence = 'composing' | 'paused';

export interface WhatsAppProvider {
  readonly kind: ProviderKind;
  capabilities(accountId: string): Capabilities;
  send(msg: OutboundMessage): Promise<SendResult>;
  markRead(accountId: string, chat: string, ids: string[]): Promise<void>;
  setPresence(accountId: string, chat: string, p: Presence): Promise<void>;
  /** Never returns secrets or QR payloads. */
  status(accountId: string): Promise<SessionHealth>;
}

export type MessageStatus =
  'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled';

export type InboundType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'view_once'
  | 'reaction'
  | 'interactive_reply'
  | 'unknown';

/** Normalised inbound message, identical shape for both providers. */
export interface InboundEvent {
  accountId: string;
  provider: ProviderKind;
  providerMessageId: string;
  /** Chat JID (PN or LID form, normalised). */
  chat: string;
  /** Sender as PN JID when known. */
  senderPn: string | null;
  /** Sender as LID JID when known. */
  senderLid: string | null;
  isGroup: boolean;
  fromMe: boolean;
  type: InboundType;
  text: string | null;
  pushName: string | null;
  timestamp: string;
  isForwarded: boolean;
  quotedProviderId: string | null;
  media: { mime: string; seconds?: number; storagePath?: string } | null;
  /** For status (story) replies: id of the status being replied to. */
  statusReplyToId: string | null;
}

/** Forward-only status ranking; `failed` always wins. */
const STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 100,
  cancelled: 99,
};

export function shouldAdvanceStatus(current: MessageStatus, next: MessageStatus): boolean {
  if (current === 'failed' || current === 'cancelled') return false;
  if (next === 'failed') return true;
  return STATUS_RANK[next] > STATUS_RANK[current];
}
