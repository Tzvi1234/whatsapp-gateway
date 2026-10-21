import { LIA_TEST_STATUSES } from '@htz/core';
import { describe, expect, it } from 'vitest';
import {
  applyTestResult,
  channelVerification,
  classifyDeliveryResponse,
  computeLiaTestResult,
  initialChannelState,
  isLiaTestStatus,
  resetOnTargetChange,
  type LiaTestInput,
} from './delivery-status';
import { nextWebhookRetry, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS } from './retry';

const MIN = 60_000;
const sent = 1_000_000;
const accepted = { status: 'accepted' as const, acceptedAtMs: sent + 800 };
const at = (ms: number, over: Partial<LiaTestInput> = {}) =>
  computeLiaTestResult({ sentAtMs: sent, nowMs: sent + ms, delivery: accepted, ...over });

describe('classifyDeliveryResponse', () => {
  it('L4.1 2xx → accepted', () => {
    expect(classifyDeliveryResponse({ kind: 'http', status: 202 }, 1)).toMatchObject({
      final: true,
      status: 'accepted',
    });
  });
  it('L4.4 401/403 → rejected_key, no retry', () => {
    for (const status of [401, 403]) {
      expect(classifyDeliveryResponse({ kind: 'http', status }, 1)).toMatchObject({
        final: true,
        status: 'rejected_key',
      });
    }
  });
  it('L4.5 timeout, network error, 5xx retry, then unreachable after the last attempt', () => {
    for (const o of [
      { kind: 'timeout' } as const,
      { kind: 'network_error' } as const,
      { kind: 'http', status: 503 } as const,
    ]) {
      expect(classifyDeliveryResponse(o, 1)).toMatchObject({ final: false, retry: true });
      expect(classifyDeliveryResponse(o, WEBHOOK_MAX_ATTEMPTS)).toMatchObject({
        final: true,
        status: 'unreachable',
      });
    }
  });
  it('other 4xx are permanent → unreachable', () => {
    expect(classifyDeliveryResponse({ kind: 'http', status: 404 }, 1)).toMatchObject({
      final: true,
      status: 'unreachable',
      reason: 'http_404',
    });
  });
});

describe('computeLiaTestResult', () => {
  it('L4.1 reply within 2 min → replied with received_ms and reply_ms', () => {
    const r = at(90_000, { reply: { repliedAtMs: sent + 60_000, delivered: true } });
    expect(r).toEqual({
      status: 'replied',
      reason: 'replied',
      elapsed_ms: 90_000,
      received_ms: 800,
      reply_ms: 60_000,
    });
  });

  it('L4.2 2xx with no reply: accepted + waiting, before and after 2 min (never a failure)', () => {
    expect(at(30_000)).toMatchObject({
      status: 'accepted',
      waiting: true,
      reason: 'awaiting_reply',
    });
    expect(at(2 * MIN + 1)).toMatchObject({
      status: 'accepted',
      waiting: true,
      reason: 'awaiting_reply_slow',
    });
    expect(at(10 * MIN - 1)?.status).toBe('accepted');
  });

  it('L4.3 no reply after the threshold (default 10, options 5/30) → no_reply', () => {
    expect(at(10 * MIN)?.status).toBe('no_reply');
    expect(at(5 * MIN, { noReplyThresholdMin: 5 })?.status).toBe('no_reply');
    expect(at(29 * MIN, { noReplyThresholdMin: 30 })?.status).toBe('accepted');
    expect(at(10 * MIN)?.waiting).toBeUndefined();
  });

  it('L4.4 / L4.5 rejected_key and unreachable pass through', () => {
    expect(at(1_000, { delivery: { status: 'rejected_key', reason: 'http_403' } })).toEqual({
      status: 'rejected_key',
      reason: 'http_403',
      elapsed_ms: 1_000,
    });
    expect(at(1_000, { delivery: { status: 'unreachable' } })?.status).toBe('unreachable');
  });

  it('L4.6 Lia replied but delivery to the owner failed → delivery_failed', () => {
    expect(at(60_000, { reply: { repliedAtMs: sent + 30_000, delivered: false } })).toMatchObject({
      status: 'delivery_failed',
      reason: 'reply_delivery_failed',
    });
  });

  it('returns null while the POST is in flight', () => {
    expect(at(1_000, { delivery: { status: 'pending' } })).toBeNull();
  });

  it('L4.10 every produced status is in the canonical enum', () => {
    const produced = [
      at(1),
      at(3 * MIN),
      at(11 * MIN),
      at(1, { reply: { repliedAtMs: sent + 1, delivered: true } }),
      at(1, { reply: { repliedAtMs: sent + 1, delivered: false } }),
      at(1, { delivery: { status: 'rejected_key' } }),
      at(1, { delivery: { status: 'unreachable' } }),
    ].map((r) => r!.status);
    for (const s of produced) expect(isLiaTestStatus(s)).toBe(true);
    expect(new Set(produced)).toEqual(new Set(LIA_TEST_STATUSES));
    expect(isLiaTestStatus('untested')).toBe(false);
  });
});

describe('channel state', () => {
  const replied = at(1, { reply: { repliedAtMs: sent + 1, delivered: true } })!;
  const waiting = at(1)!;

  it('L5.2 saved without a test is untested', () => {
    expect(channelVerification(initialChannelState())).toBe('untested');
  });
  it('L5.3 accepted only stays untested', () => {
    const s = applyTestResult(initialChannelState(), waiting, '2026-10-21T12:00:00Z');
    expect(channelVerification(s)).toBe('untested');
    expect(s.last_test).toEqual(waiting);
  });
  it('L5.4 replied sets last_verified_at; a later failed test keeps it but updates last_test', () => {
    const s = applyTestResult(initialChannelState(), replied, '2026-10-21T12:00:00Z');
    expect(s.last_verified_at).toBe('2026-10-21T12:00:00Z');
    const s2 = applyTestResult(s, waiting, '2026-10-21T13:00:00Z');
    expect(s2.last_verified_at).toBe('2026-10-21T12:00:00Z');
    expect(s2.last_test).toEqual(waiting);
  });
  it('L5.5 changing URL or sender key resets last_verified_at', () => {
    const s = applyTestResult(initialChannelState(), replied, '2026-10-21T12:00:00Z');
    const id = { url: 'https://hooks.grok.example/a', keyFingerprint: 'k1' };
    expect(resetOnTargetChange(s, id, id).last_verified_at).not.toBeNull();
    expect(
      resetOnTargetChange(s, id, { ...id, url: 'https://hooks.grok.example/b' }).last_verified_at,
    ).toBeNull();
    expect(resetOnTargetChange(s, id, { ...id, keyFingerprint: 'k2' }).last_verified_at).toBeNull();
  });
});

describe('nextWebhookRetry', () => {
  it('follows 10s, 30s, 2m, 10m, 30m, 2h then dead', () => {
    const mid = () => 0.5; // zero jitter
    expect(WEBHOOK_RETRY_DELAYS_MS.map((_d, i) => nextWebhookRetry(i + 1, mid))).toEqual(
      [10_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000].map((delayMs) => ({
        action: 'retry',
        delayMs,
      })),
    );
    expect(nextWebhookRetry(7, mid)).toEqual({ action: 'dead' });
    expect(nextWebhookRetry(0, mid)).toEqual({ action: 'dead' });
  });
  it('applies bounded jitter', () => {
    const lo = nextWebhookRetry(1, () => 0);
    const hi = nextWebhookRetry(1, () => 0.999999);
    expect(lo).toEqual({ action: 'retry', delayMs: 8_000 });
    expect(hi.action === 'retry' && hi.delayMs).toBe(12_000);
  });
});
