import {
  LIA_DEFAULT_NO_REPLY_MIN,
  LIA_NO_REPLY_THRESHOLDS_MIN,
  LIA_TEST_STATUSES,
  LIA_WAITING_WINDOW_MS,
  type LiaTestResult,
  type LiaTestStatus,
  type RelayChannelState,
} from '@htz/core';
import { WEBHOOK_MAX_ATTEMPTS } from './retry';

/** What happened to one POST attempt. */
export type DeliveryAttemptOutcome =
  { kind: 'http'; status: number } | { kind: 'network_error' } | { kind: 'timeout' };

export type DeliveryClassification =
  | { final: true; status: 'accepted' | 'rejected_key' | 'unreachable'; reason: string }
  | { final: false; retry: true; reason: string };

/**
 * Canonical delivery classification (contract + ARCH §4.7): 2xx → accepted; 401/403 →
 * rejected_key (no retry); network/timeout/5xx/429 → retry, then unreachable once
 * `attemptsMade` reaches `maxAttempts`. Other 4xx are permanent → unreachable.
 */
export function classifyDeliveryResponse(
  outcome: DeliveryAttemptOutcome,
  attemptsMade: number,
  maxAttempts: number = WEBHOOK_MAX_ATTEMPTS,
): DeliveryClassification {
  const exhausted = attemptsMade >= maxAttempts;
  const retryOr = (reason: string): DeliveryClassification =>
    exhausted
      ? { final: true, status: 'unreachable', reason }
      : { final: false, retry: true, reason };

  if (outcome.kind === 'network_error') return retryOr('network_error');
  if (outcome.kind === 'timeout') return retryOr('timeout');
  const s = outcome.status;
  if (s >= 200 && s < 300) return { final: true, status: 'accepted', reason: `http_${s}` };
  if (s === 401 || s === 403) return { final: true, status: 'rejected_key', reason: `http_${s}` };
  if (s >= 500 || s === 429 || s === 408) return retryOr(`http_${s}`);
  return { final: true, status: 'unreachable', reason: `http_${s}` };
}

export type NoReplyThresholdMin = (typeof LIA_NO_REPLY_THRESHOLDS_MIN)[number];

export interface LiaTestInput {
  /** When the test batch was first POSTed. */
  sentAtMs: number;
  nowMs: number;
  /** Final delivery classification, or `pending` while the POST/retries are in flight. */
  delivery:
    | { status: 'pending' }
    | { status: 'accepted'; acceptedAtMs: number }
    | { status: 'rejected_key'; reason?: string }
    | { status: 'unreachable'; reason?: string };
  /** Lia's reply (MCP send with reply_to_id = test batch), if any. */
  reply?: { repliedAtMs: number; delivered: boolean } | null;
  noReplyThresholdMin?: NoReplyThresholdMin;
}

/**
 * Lia connection-test status per contracts/lia-connection-test.md. Returns null while the
 * POST is still in flight (no enum value applies yet).
 * - accepted: `waiting: true` until a reply or the no-reply threshold; never a failure at 2 min.
 * - replied: with `received_ms` (send → 2xx) and `reply_ms` (send → reply).
 * - delivery_failed: Lia replied but sending to the owner failed.
 */
export function computeLiaTestResult(input: LiaTestInput): LiaTestResult | null {
  const elapsed = Math.max(0, input.nowMs - input.sentAtMs);
  const d = input.delivery;
  switch (d.status) {
    case 'pending':
      return null;
    case 'rejected_key':
      return { status: 'rejected_key', reason: d.reason ?? 'http_401', elapsed_ms: elapsed };
    case 'unreachable':
      return { status: 'unreachable', reason: d.reason ?? 'unreachable', elapsed_ms: elapsed };
    case 'accepted':
      break;
  }
  const received = Math.max(0, d.acceptedAtMs - input.sentAtMs);
  const reply = input.reply;
  if (reply) {
    const replyMs = Math.max(0, reply.repliedAtMs - input.sentAtMs);
    if (!reply.delivered) {
      return {
        status: 'delivery_failed',
        reason: 'reply_delivery_failed',
        elapsed_ms: elapsed,
        received_ms: received,
        reply_ms: replyMs,
      };
    }
    return {
      status: 'replied',
      reason: 'replied',
      elapsed_ms: elapsed,
      received_ms: received,
      reply_ms: replyMs,
    };
  }
  const thresholdMs = (input.noReplyThresholdMin ?? LIA_DEFAULT_NO_REPLY_MIN) * 60_000;
  if (elapsed >= thresholdMs) {
    return { status: 'no_reply', reason: 'no_reply_after_threshold', elapsed_ms: elapsed };
  }
  return {
    status: 'accepted',
    waiting: true,
    reason: elapsed < LIA_WAITING_WINDOW_MS ? 'awaiting_reply' : 'awaiting_reply_slow',
    elapsed_ms: elapsed,
  };
}

export function isLiaTestStatus(v: unknown): v is LiaTestStatus {
  return typeof v === 'string' && (LIA_TEST_STATUSES as readonly string[]).includes(v);
}

export type ChannelVerification = 'untested' | 'verified';

export const initialChannelState = (): RelayChannelState => ({
  last_verified_at: null,
  last_test: null,
});

/** `untested` is derived, never stored in the status enum (L5.2). */
export function channelVerification(state: RelayChannelState): ChannelVerification {
  return state.last_verified_at === null ? 'untested' : 'verified';
}

/** Record the latest test. Only `replied` sets `last_verified_at` (L5.3/L5.4). */
export function applyTestResult(
  state: RelayChannelState,
  result: LiaTestResult,
  nowIso: string,
): RelayChannelState {
  return {
    last_test: result,
    last_verified_at: result.status === 'replied' ? nowIso : state.last_verified_at,
  };
}

export interface RelayTargetIdentity {
  url: string;
  /** A fingerprint (e.g. hash or vault secret version) of the sender key, never the key. */
  keyFingerprint: string;
}

/** Any change of webhook URL or sender key resets verification (L5.5). */
export function resetOnTargetChange(
  state: RelayChannelState,
  before: RelayTargetIdentity,
  after: RelayTargetIdentity,
): RelayChannelState {
  const changed = before.url !== after.url || before.keyFingerprint !== after.keyFingerprint;
  return changed ? { ...state, last_verified_at: null } : state;
}
