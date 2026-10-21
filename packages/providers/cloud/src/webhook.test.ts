import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyStatus,
  foldStatusUpdates,
  handleVerifyChallenge,
  parseWebhook,
  verifyMetaSignature,
  type StatusUpdate,
} from './webhook';
import { FAKE_APP_SECRET, FAKE_PHONE_ID, TEST_NUMBER, webhookFixture } from './test-helpers';

const NOW = new Date('2026-10-21T10:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const accountIdFor = (id: string) => (id === FAKE_PHONE_ID ? 'acc-cloud-1' : null);

function sign(raw: Uint8Array | string, secret = FAKE_APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

const textMsg = (id: string, ts = NOW_SEC - 5) => ({
  from: TEST_NUMBER,
  id,
  timestamp: String(ts),
  type: 'text',
  text: { body: 'שלום' },
});

describe('verifyMetaSignature', () => {
  // Raw body with non-canonical spacing + Hebrew so re-serialisation changes the bytes.
  const raw = Buffer.from(
    `{"object":"whatsapp_business_account",  "entry":[{"id":"1","changes":[]}], "note":"שלום"}`,
    'utf8',
  );

  it('S1 accepts a valid signature over the exact raw bytes', () => {
    expect(verifyMetaSignature(raw, sign(raw), FAKE_APP_SECRET)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      verifyMetaSignature(
        new Uint8Array(raw),
        sign(raw).toUpperCase().replace('SHA256', 'sha256'),
        FAKE_APP_SECRET,
      ).ok,
    ).toBe(true);
  });

  it('S1 rejects a body that was parsed and re-serialised', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
    expect(reserialised.equals(raw)).toBe(false);
    const r = verifyMetaSignature(reserialised, sign(raw), FAKE_APP_SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'unauthorized', detail: 'bad_signature' });
  });

  it('S1 rejects a signature made with the wrong secret', () => {
    const r = verifyMetaSignature(raw, sign(raw, 'other-secret'), FAKE_APP_SECRET);
    expect(r.ok).toBe(false);
  });

  it('S1 rejects a missing or malformed header and a missing secret', () => {
    const missing = verifyMetaSignature(raw, null, FAKE_APP_SECRET);
    expect(!missing.ok && missing.error.detail).toBe('missing_header');
    const short = verifyMetaSignature(raw, 'sha256=abcd', FAKE_APP_SECRET);
    expect(!short.ok && short.error.detail).toBe('malformed_header');
    const sha1 = verifyMetaSignature(raw, sign(raw).replace('sha256=', 'sha1='), FAKE_APP_SECRET);
    expect(!sha1.ok && sha1.error.detail).toBe('malformed_header');
    const noSecret = verifyMetaSignature(raw, sign(raw), '');
    expect(!noSecret.ok && noSecret.error.detail).toBe('missing_secret');
  });
});

describe('handleVerifyChallenge', () => {
  const good = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'verify-me',
    'hub.challenge': '12345',
  };

  it('S2 returns the challenge for the right token', () => {
    expect(handleVerifyChallenge(new URLSearchParams(good), 'verify-me')).toEqual({
      status: 200,
      body: '12345',
    });
  });

  it('S2 returns 403 for a wrong verify token, wrong mode or missing challenge', () => {
    expect(handleVerifyChallenge({ ...good, 'hub.verify_token': 'nope' }, 'verify-me').status).toBe(
      403,
    );
    expect(
      handleVerifyChallenge({ ...good, 'hub.verify_token': 'verify-mE' }, 'verify-me').status,
    ).toBe(403);
    expect(handleVerifyChallenge({ ...good, 'hub.mode': 'unsubscribe' }, 'verify-me').status).toBe(
      403,
    );
    expect(handleVerifyChallenge({ ...good, 'hub.challenge': undefined }, 'verify-me').status).toBe(
      403,
    );
    expect(handleVerifyChallenge(good, '').status).toBe(403);
  });
});

describe('parseWebhook', () => {
  it('S1 normalises inbound text with dedupe keys and push name', () => {
    const r = parseWebhook(webhookFixture({ nowSec: NOW_SEC, messages: [textMsg('wamid.A')] }), {
      accountIdFor,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.inbound).toHaveLength(1);
    const item = r.value.inbound[0]!;
    expect(item.dedupeKey).toBe('meta:msg:wamid.A');
    expect(item.event).toMatchObject({
      accountId: 'acc-cloud-1',
      provider: 'meta_cloud',
      providerMessageId: 'wamid.A',
      chat: `${TEST_NUMBER}@s.whatsapp.net`,
      senderPn: `${TEST_NUMBER}@s.whatsapp.net`,
      type: 'text',
      text: 'שלום',
      pushName: 'Test User',
      fromMe: false,
      isGroup: false,
    });
  });

  it('S1 rejects replayed entries older than 24h', () => {
    const old = NOW_SEC - 24 * 3600 - 60;
    const r = parseWebhook(
      webhookFixture({
        nowSec: NOW_SEC,
        messages: [textMsg('wamid.OLD', old), textMsg('wamid.NEW')],
        statuses: [
          { id: 'wamid.S', status: 'delivered', timestamp: String(old), recipient_id: TEST_NUMBER },
        ],
      }),
      { accountIdFor, now: NOW },
    );
    expect(r.ok && r.value.inbound.map((i) => i.event.providerMessageId)).toEqual(['wamid.NEW']);
    expect(r.ok && r.value.statuses).toEqual([]);
    expect(r.ok && r.value.rejected).toEqual([
      { dedupeKey: 'meta:msg:wamid.OLD', reason: 'too_old' },
      { dedupeKey: 'meta:status:wamid.S:delivered', reason: 'too_old' },
    ]);
  });

  it('S1 rejects items for an unknown phone number id and non-whatsapp payloads', () => {
    const r = parseWebhook(
      webhookFixture({ nowSec: NOW_SEC, messages: [textMsg('wamid.X')], phoneNumberId: '999' }),
      { accountIdFor, now: NOW },
    );
    expect(r.ok && r.value.rejected).toEqual([
      { dedupeKey: 'meta:msg:wamid.X', reason: 'unknown_phone_number' },
    ]);
    expect(parseWebhook({ object: 'page', entry: [] }, { accountIdFor }).ok).toBe(false);
    expect(parseWebhook('garbage', { accountIdFor }).ok).toBe(false);
  });

  it('maps media, voice, interactive replies, reactions and forwarded context', () => {
    const r = parseWebhook(
      webhookFixture({
        nowSec: NOW_SEC,
        messages: [
          {
            ...textMsg('m1'),
            type: 'audio',
            text: undefined,
            audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true },
          },
          {
            ...textMsg('m2'),
            type: 'image',
            text: undefined,
            image: { id: 'media-2', mime_type: 'image/jpeg', caption: 'תמונה' },
          },
          {
            ...textMsg('m3'),
            type: 'interactive',
            text: undefined,
            interactive: { type: 'button_reply', button_reply: { id: 'opt_1', title: 'כן' } },
          },
          {
            ...textMsg('m4'),
            type: 'reaction',
            text: undefined,
            reaction: { message_id: 'wamid.T', emoji: '👍' },
          },
          { ...textMsg('m5'), context: { forwarded: true } },
          { ...textMsg('m6'), type: 'unsupported', text: undefined },
        ],
      }),
      { accountIdFor, now: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [voice, image, button, reaction, fwd, unknown] = r.value.inbound;
    expect(voice).toMatchObject({
      mediaId: 'media-1',
      event: { type: 'voice', media: { mime: 'audio/ogg; codecs=opus' } },
    });
    expect(image?.event).toMatchObject({ type: 'image', text: 'תמונה' });
    expect(button?.event).toMatchObject({ type: 'interactive_reply', text: 'כן' });
    expect(reaction?.event).toMatchObject({
      type: 'reaction',
      text: '👍',
      quotedProviderId: 'wamid.T',
    });
    expect(fwd?.event.isForwarded).toBe(true);
    expect(unknown?.event.type).toBe('unknown');
  });

  it('R4.7 maps statuses with error codes and dedupe keys', () => {
    const r = parseWebhook(
      webhookFixture({
        nowSec: NOW_SEC,
        statuses: [
          {
            id: 'w1',
            status: 'delivered',
            timestamp: String(NOW_SEC - 2),
            recipient_id: TEST_NUMBER,
          },
          {
            id: 'w1',
            status: 'failed',
            timestamp: String(NOW_SEC - 1),
            recipient_id: TEST_NUMBER,
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          },
        ],
      }),
      { accountIdFor, now: NOW },
    );
    expect(r.ok && r.value.statuses.map((s) => [s.dedupeKey, s.status, s.errorCode])).toEqual([
      ['meta:status:w1:delivered', 'delivered', null],
      ['meta:status:w1:failed', 'failed', 'outside_24h_window'],
    ]);
  });
});

describe('forward-only status ranking', () => {
  const upd = (id: string, status: StatusUpdate['status']): StatusUpdate => ({
    dedupeKey: `k:${id}:${status}`,
    accountId: 'a',
    phoneNumberId: FAKE_PHONE_ID,
    providerMessageId: id,
    status,
    timestamp: NOW.toISOString(),
    errorCode: status === 'failed' ? 'provider_error' : null,
  });

  it('R4.7 delivered before sent keeps delivered; failed after read wins', () => {
    expect(applyStatus('delivered', 'sent')).toBe('delivered');
    expect(applyStatus('read', 'failed')).toBe('failed');
    const folded = foldStatusUpdates(
      [
        upd('a', 'delivered'),
        upd('a', 'sent'),
        upd('b', 'read'),
        upd('b', 'failed'),
        upd('c', 'sent'),
      ],
      (id) => (id === 'c' ? 'read' : 'sent'),
    );
    expect(folded.get('a')).toEqual({ status: 'delivered', errorCode: null });
    expect(folded.get('b')).toEqual({ status: 'failed', errorCode: 'provider_error' });
    expect(folded.has('c')).toBe(false); // stale: already read
  });
});
