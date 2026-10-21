import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildWebhookHeaders, signWebhook, verifyWebhookSignature } from './signature';

// Test-only dummy secrets.
const SECRET = 'test-secret-a';
const SECRET_NEW = 'test-secret-b';
const BODY = '{"batch_id":"b-1","is_test":false,"messages":[]}';
const NOW = 1_790_000_000;

describe('webhook signature', () => {
  it('L4.9 header is t=<ts>,v1=HMAC_SHA256(secret, t + "." + raw_body)', () => {
    const h = signWebhook(SECRET, BODY, NOW);
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    expect(h).toBe(`t=${NOW},v1=${expected}`);
  });

  it('L4.9 receiver accepts within tolerance and rejects skew >5 min', () => {
    const h = signWebhook(SECRET, BODY, NOW);
    expect(verifyWebhookSignature(h, BODY, [SECRET], NOW + 300).ok).toBe(true);
    expect(verifyWebhookSignature(h, BODY, [SECRET], NOW - 300).ok).toBe(true);
    const late = verifyWebhookSignature(h, BODY, [SECRET], NOW + 301);
    expect(!late.ok && late.error.detail).toBe('signature_stale');
    expect(verifyWebhookSignature(h, BODY, [SECRET], NOW - 301).ok).toBe(false);
  });

  it('L4.9 rejects tampered body, wrong secret, missing and malformed headers', () => {
    const h = signWebhook(SECRET, BODY, NOW);
    expect(verifyWebhookSignature(h, BODY + ' ', [SECRET], NOW).ok).toBe(false);
    expect(verifyWebhookSignature(h, BODY, ['wrong'], NOW).ok).toBe(false);
    expect(verifyWebhookSignature(null, BODY, [SECRET], NOW)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', detail: 'signature_missing' },
    });
    expect(verifyWebhookSignature('t=abc,v1=zz', BODY, [SECRET], NOW)).toMatchObject({
      ok: false,
      error: { detail: 'signature_malformed' },
    });
    expect(verifyWebhookSignature(h, BODY, [], NOW).ok).toBe(false);
  });

  it('L4.9 dual-secret rotation: old and new secret both verify during overlap', () => {
    const oldSig = signWebhook(SECRET, BODY, NOW);
    const newSig = signWebhook(SECRET_NEW, BODY, NOW);
    expect(verifyWebhookSignature(oldSig, BODY, [SECRET_NEW, SECRET], NOW).ok).toBe(true);
    expect(verifyWebhookSignature(newSig, BODY, [SECRET_NEW, SECRET], NOW).ok).toBe(true);
    expect(verifyWebhookSignature(oldSig, BODY, [SECRET_NEW], NOW).ok).toBe(false);
  });

  it('L4.7 headers carry Idempotency-Key = batch_id', () => {
    const h = buildWebhookHeaders({
      secret: SECRET,
      rawBody: BODY,
      idempotencyKey: 'b-1',
      nowSec: NOW,
    });
    expect(h['Idempotency-Key']).toBe('b-1');
    expect(h['X-Gateway-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(h['Content-Type']).toBe('application/json');
  });
});
