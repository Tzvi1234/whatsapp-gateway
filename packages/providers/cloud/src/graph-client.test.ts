import { describe, expect, it } from 'vitest';
import { buildInteractive, classifyGraphError, GraphClient, GRAPH_VERSION } from './graph-client';
import { FAKE_PHONE_ID, FAKE_TOKEN, fakeFetch, graphError, TEST_NUMBER } from './test-helpers';

const creds = { phoneNumberId: FAKE_PHONE_ID, accessToken: FAKE_TOKEN };
const ok = { status: 200, json: { messages: [{ id: 'wamid.OK' }] } };

describe('classifyGraphError', () => {
  it.each([
    [400, 131047, 'outside_24h_window', false],
    [400, 131026, 'invalid_number', false],
    [400, 132001, 'template_not_found', false],
    [401, 190, 'invalid_credentials', false],
    [403, 10, 'invalid_credentials', false],
    [400, 130429, 'rate_limited', true],
    [400, 131056, 'rate_limited', true],
    [500, 131000, 'provider_error', true],
    [503, undefined, 'provider_error', true],
    [400, 999999, 'provider_error', false],
  ] as const)(
    'R4.2/R4.5 status %i code %s → %s (transient %s)',
    (status, code, expected, transient) => {
      const e = classifyGraphError(status, code === undefined ? null : graphError(code));
      expect(e.code).toBe(expected);
      expect(e.transient).toBe(transient);
      expect(e.detail).toMatch(/^graph_\d{3}/);
    },
  );

  it('R4.5 429 is rate_limited with retryAfter from the header', () => {
    const e = classifyGraphError(429, graphError(4), new Headers({ 'retry-after': '12' }));
    expect(e).toMatchObject({ code: 'rate_limited', transient: true, retryAfterMs: 12_000 });
  });

  it('R4.2 outside the window maps to outside_24h_window with action use send_template', async () => {
    const { ERROR_ACTION } = await import('@htz/core');
    expect(ERROR_ACTION[classifyGraphError(400, graphError(131047)).code]).toBe(
      'use send_template',
    );
  });
});

describe('GraphClient', () => {
  it('sends text with pinned version, bearer header, no token in URL or body', async () => {
    const f = fakeFetch([ok]);
    const g = new GraphClient({ fetch: f.fetch });
    const r = await g.sendText(creds, '055-901-4410', 'hi', { replyToId: 'wamid.Q' });
    expect(r).toEqual({ ok: true, value: { messageId: 'wamid.OK' } });
    const call = f.calls[0]!;
    expect(call.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/${FAKE_PHONE_ID}/messages`);
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(call.url).not.toContain(FAKE_TOKEN);
    expect(call.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TEST_NUMBER,
      type: 'text',
      text: { body: 'hi', preview_url: false },
      context: { message_id: 'wamid.Q' },
    });
  });

  it('version is configurable', async () => {
    const f = fakeFetch([ok]);
    await new GraphClient({ fetch: f.fetch, version: 'v99.0' }).sendText(creds, TEST_NUMBER, 'x');
    expect(f.calls[0]!.url).toContain('/v99.0/');
  });

  it('never leaks the token in errors', async () => {
    const f = fakeFetch([
      { status: 401, json: { error: { code: 190, message: `bad ${FAKE_TOKEN}` } } },
    ]);
    const r = await new GraphClient({ fetch: f.fetch }).sendText(creds, TEST_NUMBER, 'x');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
    if (!r.ok) expect(r.error.code).toBe('invalid_credentials');
  });

  it('R4.5 network failure and timeout are transient', async () => {
    const net = await new GraphClient({
      fetch: fakeFetch([{ throws: new TypeError('fetch failed') }]).fetch,
    }).sendText(creds, TEST_NUMBER, 'x');
    expect(!net.ok && net.error).toMatchObject({ code: 'network', transient: true });
    const to = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const tmo = await new GraphClient({ fetch: fakeFetch([{ throws: to }]).fetch }).sendText(
      creds,
      TEST_NUMBER,
      'x',
    );
    expect(!tmo.ok && tmo.error).toMatchObject({ code: 'timeout', transient: true });
  });

  it('rejects invalid recipients and group JIDs before calling Graph', async () => {
    const f = fakeFetch([]);
    const g = new GraphClient({ fetch: f.fetch });
    expect((await g.sendText(creds, 'abc', 'x')).ok).toBe(false);
    const grp = await g.sendText(creds, '1203630@g.us', 'x');
    expect(!grp.ok && grp.error.code).toBe('capability_unsupported');
    expect(f.calls).toHaveLength(0);
  });

  it('builds template, media, reaction, read+typing and upload requests', async () => {
    const f = fakeFetch([
      ok,
      ok,
      ok,
      { status: 200, json: { success: true } },
      { status: 200, json: { id: 'media-9' } },
    ]);
    const g = new GraphClient({ fetch: f.fetch });
    await g.sendTemplate(creds, TEST_NUMBER, {
      name: 'reminder_v1',
      language: 'he',
      bodyParams: ['א', 'ב'],
    });
    await g.sendMedia(creds, TEST_NUMBER, {
      type: 'document',
      source: { id: 'mid' },
      caption: 'c',
      filename: 'a.pdf',
    });
    await g.sendReaction(creds, TEST_NUMBER, 'wamid.T', '👍');
    await g.markRead(creds, 'wamid.IN', { typing: true });
    const up = await g.uploadMedia(creds, new Uint8Array([1, 2, 3]), 'image/png', 'a.png');
    expect(up).toEqual({ ok: true, value: { id: 'media-9' } });
    expect(f.calls[0]!.body).toMatchObject({
      type: 'template',
      template: {
        name: 'reminder_v1',
        language: { code: 'he' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'א' },
              { type: 'text', text: 'ב' },
            ],
          },
        ],
      },
    });
    expect(f.calls[1]!.body).toMatchObject({
      type: 'document',
      document: { id: 'mid', caption: 'c', filename: 'a.pdf' },
    });
    expect(f.calls[2]!.body).toMatchObject({
      type: 'reaction',
      reaction: { message_id: 'wamid.T', emoji: '👍' },
    });
    expect(f.calls[3]!.body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
      typing_indicator: { type: 'text' },
    });
    expect(f.calls[4]!.url).toMatch(/\/media$/);
    expect(f.calls[4]!.body).toBeInstanceOf(FormData);
  });
});

describe('buildInteractive', () => {
  it('reply buttons ≤3 and list rows ≤10', () => {
    expect(buildInteractive({ style: 'buttons', body: 'b', options: ['1', '2', '3'] }).ok).toBe(
      true,
    );
    const four = buildInteractive({ style: 'buttons', body: 'b', options: ['1', '2', '3', '4'] });
    expect(!four.ok && four.error.detail).toBe('too_many_buttons');
    const longBtn = buildInteractive({ style: 'buttons', body: 'b', options: ['x'.repeat(21)] });
    expect(longBtn.ok).toBe(false);
    const ten = buildInteractive({
      style: 'list',
      body: 'b',
      options: Array.from({ length: 10 }, (_, i) => `row ${i}`),
    });
    expect(ten.ok).toBe(true);
    expect(
      buildInteractive({
        style: 'list',
        body: 'b',
        options: Array.from({ length: 11 }, (_, i) => `r${i}`),
      }).ok,
    ).toBe(false);
    const long = buildInteractive({ style: 'list', body: 'b', options: ['y'.repeat(40)] });
    expect(long.ok && JSON.stringify(long.value)).toContain('description');
  });
});
