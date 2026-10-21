import { describe, expect, it } from 'vitest';
import { ok, type OutboundMessage } from '@htz/core';
import { CloudApiProvider, CloudProviderError, mediaTypeForMime } from './provider';
import { FAKE_PHONE_ID, FAKE_TOKEN, fakeFetch, graphError, TEST_NUMBER } from './test-helpers';

const creds = { phoneNumberId: FAKE_PHONE_ID, accessToken: FAKE_TOKEN };
const base: OutboundMessage = {
  accountId: 'acc-1',
  to: `+${TEST_NUMBER}`,
  kind: 'text',
  text: 'שלום',
  idempotencyKey: 'k1',
  useCase: 'reminders',
};

describe('CloudApiProvider', () => {
  it('R4.4 missing credentials → provider_unconfigured, no Graph call, status unconfigured', async () => {
    const f = fakeFetch([]);
    const p = new CloudApiProvider({
      credentials: async () => null,
      graphOptions: { fetch: f.fetch },
    });
    const r = await p.send(base);
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'provider_unconfigured',
        transient: false,
        detail: 'cloud_credentials_missing',
      },
    });
    const s = await p.status('acc-1');
    expect(s).toMatchObject({
      connection: 'unconfigured',
      provider: 'meta_cloud',
      lastErrorCode: null,
    });
    expect(f.calls).toHaveLength(0);
  });

  it('R4.1 sends text and returns the wamid', async () => {
    const f = fakeFetch([{ status: 200, json: { messages: [{ id: 'wamid.1' }] } }]);
    const p = new CloudApiProvider({
      credentials: async () => creds,
      graphOptions: { fetch: f.fetch },
    });
    expect(await p.send(base)).toEqual({
      ok: true,
      providerMessageId: 'wamid.1',
      deliveryMode: 'native',
    });
    expect(p.capabilities('acc-1').templates).toBe(true);
  });

  it('R4.2 outside the 24h window returns a permanent outside_24h_window', async () => {
    const f = fakeFetch([{ status: 400, json: graphError(131047) }]);
    const p = new CloudApiProvider({
      credentials: async () => creds,
      graphOptions: { fetch: f.fetch },
    });
    const r = await p.send(base);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'outside_24h_window', transient: false });
  });

  it('R4.3 sends a template', async () => {
    const f = fakeFetch([{ status: 200, json: { messages: [{ id: 'wamid.T' }] } }]);
    const p = new CloudApiProvider({
      credentials: async () => creds,
      graphOptions: { fetch: f.fetch },
    });
    const r = await p.send({
      ...base,
      kind: 'template',
      template: { name: 'appt', language: 'he', params: ['10:00'] },
    });
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.body).toMatchObject({ type: 'template', template: { name: 'appt' } });
  });

  it('uploads resolved media bytes, then sends by media id', async () => {
    const f = fakeFetch([
      { status: 200, json: { id: 'media-1' } },
      { status: 200, json: { messages: [{ id: 'wamid.M' }] } },
    ]);
    const p = new CloudApiProvider({
      credentials: async () => creds,
      graphOptions: { fetch: f.fetch },
      resolveMedia: async () => ok({ bytes: new Uint8Array([1]), filename: 'v.ogg' }),
    });
    const r = await p.send({
      ...base,
      kind: 'media',
      media: { storagePath: 'media/a.ogg', mime: 'audio/ogg', voice: true },
    });
    expect(r).toMatchObject({ ok: true, providerMessageId: 'wamid.M' });
    expect(f.calls[1]!.body).toMatchObject({ type: 'audio', audio: { id: 'media-1' } });
  });

  it('media without a resolver needs an https link', async () => {
    const p = new CloudApiProvider({
      credentials: async () => creds,
      graphOptions: { fetch: fakeFetch([]).fetch },
    });
    const r = await p.send({
      ...base,
      kind: 'media',
      media: { storagePath: 'media/a.jpg', mime: 'image/jpeg' },
    });
    expect(r.error?.code).toBe('capability_unsupported');
  });

  it('markRead throws a typed error instead of failing silently; status never contains the token', async () => {
    const f = fakeFetch([
      { status: 401, json: graphError(190) },
      { status: 401, json: graphError(190) },
    ]);
    const p = new CloudApiProvider({
      credentials: async () => creds,
      graphOptions: { fetch: f.fetch },
    });
    await expect(p.markRead('acc-1', TEST_NUMBER, ['wamid.X'])).rejects.toBeInstanceOf(
      CloudProviderError,
    );
    const s = await p.status('acc-1');
    expect(s).toMatchObject({ connection: 'closed', lastErrorCode: 'invalid_credentials' });
    expect(JSON.stringify(s)).not.toContain(FAKE_TOKEN);
  });

  it('maps mime types', () => {
    expect(mediaTypeForMime('image/jpeg')).toBe('image');
    expect(mediaTypeForMime('image/webp')).toBe('sticker');
    expect(mediaTypeForMime('video/mp4')).toBe('video');
    expect(mediaTypeForMime('application/pdf')).toBe('document');
    expect(mediaTypeForMime('application/ogg', true)).toBe('audio');
  });
});
