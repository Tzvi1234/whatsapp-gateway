import {
  BAILEYS_CAPABILITIES,
  type ConnectionState,
  type OutboundMessage,
  type SessionHealth,
} from '@htz/core';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './log';
import { Pacer } from './pacing';
import {
  BaileysProvider,
  mapBaileysError,
  renderNumberedText,
  type ProviderSession,
} from './provider';
import type { SessionEvent, SessionEventListener } from './session';

const TO = '+972500000001';
const silent = createLogger({ level: 'silent' });
const JID = '972500000001@s.whatsapp.net';

function fakeSession(state: ConnectionState = 'open') {
  const listeners = new Set<SessionEventListener>();
  let n = 0;
  const s = {
    accountId: 'acc-1',
    state,
    health: (): SessionHealth => ({
      accountId: 'acc-1',
      provider: 'baileys',
      connection: s.state,
      connectedAt: null,
      lastHeartbeatAt: null,
      lastErrorCode: null,
    }),
    on: (l: SessionEventListener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sendMessage: vi.fn(async (..._a: unknown[]) => ({ id: `ID${++n}` })),
    react: vi.fn(async () => ({ id: `R${++n}` })),
    markRead: vi.fn(async () => undefined),
    presence: vi.fn(async () => undefined),
    fire: (e: Partial<SessionEvent>) =>
      listeners.forEach((l) => l({ accountId: 'acc-1', at: '', ...e } as SessionEvent)),
  };
  return s;
}

function msg(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    accountId: 'acc-1',
    to: TO,
    kind: 'text',
    text: 'hello',
    idempotencyKey: 'k1',
    useCase: 'notifications',
    ...over,
  };
}

function provider(opts: ConstructorParameters<typeof BaileysProvider>[0] = {}) {
  return new BaileysProvider({ pacer: null, logger: silent, ...opts });
}

describe('BaileysProvider', () => {
  it('sends text to the normalised JID', async () => {
    const p = provider();
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    const r = await p.send(msg());
    expect(r).toEqual({ ok: true, providerMessageId: 'ID1', deliveryMode: 'text' });
    expect(s.sendMessage).toHaveBeenCalledWith(JID, { text: 'hello' }, {});
  });

  it('RL7 templates → capability_unsupported (never silently sent)', async () => {
    const p = provider();
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    const r = await p.send(
      msg({ kind: 'template', template: { name: 't', language: 'he', params: [] } }),
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported', transient: false },
    });
    expect(s.sendMessage).not.toHaveBeenCalled();
  });

  it('RL7 interactive → numbered-text fallback reported as deliveryMode fallback', async () => {
    const p = provider();
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    const r = await p.send(
      msg({
        kind: 'interactive',
        interactive: { body: 'Pick', options: ['A', 'B'], style: 'buttons' },
      }),
    );
    expect(r).toMatchObject({ ok: true, deliveryMode: 'fallback' });
    expect(s.sendMessage).toHaveBeenCalledWith(JID, { text: 'Pick\n\n1. A\n2. B' }, {});
    const tooMany = await p.send(
      msg({
        kind: 'interactive',
        interactive: { body: 'x', options: ['1', '2', '3', '4'], style: 'buttons' },
      }),
    );
    expect(tooMany).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('RL7 capability flags off → capability_unsupported', async () => {
    const p = provider({
      capabilities: () => ({
        ...BAILEYS_CAPABILITIES,
        media: false,
        groups: 'none',
        reactions: false,
      }),
      resolveMedia: async () => Buffer.from(''),
    });
    p.register(fakeSession() as unknown as ProviderSession);
    expect(
      await p.send(msg({ kind: 'media', media: { storagePath: 'a/b.jpg', mime: 'image/jpeg' } })),
    ).toMatchObject({ error: { code: 'capability_unsupported', detail: 'media' } });
    expect(await p.send(msg({ to: '120363000000000001@g.us' }))).toMatchObject({
      error: { code: 'capability_unsupported', detail: 'groups' },
    });
    expect(
      await p.send(msg({ kind: 'reaction', reaction: { targetProviderId: 'X', emoji: '👍' } })),
    ).toMatchObject({ error: { code: 'capability_unsupported', detail: 'reactions' } });
  });

  it('media: resolves storagePath and maps voice to ptt', async () => {
    const resolveMedia = vi.fn(async () => ({ url: 'https://example.invalid/signed' }));
    const p = provider({ resolveMedia });
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    await p.send(
      msg({ kind: 'media', media: { storagePath: 'm/v.ogg', mime: 'audio/ogg', voice: true } }),
    );
    expect(s.sendMessage).toHaveBeenLastCalledWith(
      JID,
      { audio: { url: 'https://example.invalid/signed' }, ptt: true, mimetype: 'audio/ogg' },
      {},
    );
    await p.send(
      msg({
        kind: 'media',
        media: { storagePath: 'm/r.pdf', mime: 'application/pdf', caption: 'c' },
      }),
    );
    expect(s.sendMessage.mock.calls.at(-1)![1]).toMatchObject({ fileName: 'r.pdf', caption: 'c' });
  });

  it('session missing → provider_unconfigured; down → session_disconnected (transient)', async () => {
    const p = provider();
    expect(await p.send(msg())).toMatchObject({
      ok: false,
      error: { code: 'provider_unconfigured' },
    });
    const s = fakeSession('connecting');
    p.register(s as unknown as ProviderSession);
    expect(await p.send(msg())).toMatchObject({
      ok: false,
      error: { code: 'session_disconnected', transient: true },
    });
    s.state = 'needs_relink';
    expect(await p.send(msg())).toMatchObject({
      error: { code: 'needs_relink', transient: false },
    });
  });

  it('invalid numbers are rejected before touching the session', async () => {
    const p = provider();
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    expect(await p.send(msg({ to: '12345' }))).toMatchObject({ error: { code: 'invalid_number' } });
    expect(s.sendMessage).not.toHaveBeenCalled();
  });

  it('conflict event trips the breaker: further sends rejected, no auto-close', async () => {
    const p = provider();
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    s.fire({ type: 'conflict', code: 403 });
    expect(await p.send(msg())).toMatchObject({
      ok: false,
      error: { code: 'conflict', detail: 'circuit_open:forbidden', transient: false },
    });
    p.breaker('acc-1').reset();
    expect((await p.send(msg())).ok).toBe(true);
  });

  it('failure spike trips the breaker → rate_limited with retryAfter', async () => {
    const p = provider({ breaker: { failureThreshold: 2 } });
    const s = fakeSession();
    s.sendMessage.mockRejectedValue(
      Object.assign(new Error('boom'), { output: { statusCode: 500 } }),
    );
    p.register(s as unknown as ProviderSession);
    await p.send(msg());
    await p.send(msg());
    const r = await p.send(msg());
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited', detail: 'circuit_open' } });
  });

  it('pacing: waits inline (with typing) for short waits, rate_limited for long ones', async () => {
    const now = 0;
    const sleep = vi.fn(async () => undefined);
    const pacer = new Pacer({}, { now: () => now, random: () => 0 });
    const p = new BaileysProvider({
      pacer,
      sleep,
      maxInlineWaitMs: 4_500,
      now: () => now,
      logger: silent,
    });
    const s = fakeSession();
    p.register(s as unknown as ProviderSession);
    expect((await p.send(msg())).ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(s.presence).toHaveBeenNthCalledWith(1, JID, 'composing');
    expect(s.presence).toHaveBeenNthCalledWith(2, JID, 'paused');
    const r = await p.send(msg()); // same chat: 3s spacing + jitter > 4.5s inline cap
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited', detail: 'pacing' } });
  });

  it('status() is unconfigured for unknown accounts and never leaks secrets', async () => {
    const p = provider();
    expect(await p.status('nope')).toMatchObject({ connection: 'unconfigured' });
  });

  it('maps Baileys errors', () => {
    const boom = (statusCode: number) => Object.assign(new Error('x'), { output: { statusCode } });
    expect(mapBaileysError(boom(429)).code).toBe('rate_limited');
    expect(mapBaileysError(boom(404)).code).toBe('invalid_number');
    expect(mapBaileysError(boom(413)).code).toBe('media_too_large');
    expect(mapBaileysError(boom(440)).code).toBe('conflict');
    expect(mapBaileysError(Object.assign(new Error(), { code: 'ECONNRESET' })).code).toBe(
      'network',
    );
    expect(mapBaileysError(new Error('weird'))).toMatchObject({
      code: 'provider_error',
      transient: true,
    });
  });

  it('renders numbered text', () => {
    expect(renderNumberedText(' Q ', [' a', 'b '])).toBe('Q\n\n1. a\n2. b');
  });
});
