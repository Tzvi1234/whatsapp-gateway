/** Canonical Lia connection-test / relay delivery status enum (contracts/lia-connection-test.md). */
export const LIA_TEST_STATUSES = [
  'accepted',
  'replied',
  'rejected_key',
  'unreachable',
  'no_reply',
  'delivery_failed',
] as const;
export type LiaTestStatus = (typeof LIA_TEST_STATUSES)[number];

export interface LiaTestResult {
  status: LiaTestStatus;
  /** only with "accepted" */
  waiting?: boolean;
  /** stable English code; Hebrew copy lives in the dashboard */
  reason: string;
  elapsed_ms: number;
  received_ms?: number;
  reply_ms?: number;
}

export interface RelayChannelState {
  last_verified_at: string | null;
  last_test: LiaTestResult | null;
}

export type RelayMessageType =
  'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'unsupported';

export interface RelayMessage {
  message_id: string;
  from: string;
  timestamp: string;
  type: RelayMessageType;
  text: string | null;
  media_url: string | null;
  transcript: string | null;
  reply_to_id: string | null;
  is_forwarded: boolean;
}

export interface RelayBatchPayload {
  batch_id: string;
  is_test: boolean;
  messages: RelayMessage[];
}

/** Follow-up event when a transcript arrives after its batch was already delivered. */
export interface RelayTranscriptEvent {
  event: 'transcript';
  batch_id: string;
  message_id: string;
  transcript: string | null;
}

export const LIA_WAITING_WINDOW_MS = 2 * 60_000;
export const LIA_NO_REPLY_THRESHOLDS_MIN = [5, 10, 30] as const;
export const LIA_DEFAULT_NO_REPLY_MIN = 10;
export const RELAY_DEFAULT_DEBOUNCE_MS = 4_000;
export const RELAY_TRANSCRIPT_CAP_MS = 30_000;
export const VOICE_LONG_THRESHOLD_S = 60;
