import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { initAuthCreds, type BaileysEventMap, type UserFacingSocketConfig } from 'baileys';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './log';
import { BaileysSession, sessionEventRow, type BaileysSocket, type SessionEvent } from './session';
import { SessionCipher } from './store/crypto';
import { createSupabaseSessionStore, InMemoryBaileysAuthStateDb } from './store/supabase-store';
import type { SessionStore } from './store/types';

// Fictitious identities only.
const PAIRING = '+972559014410';
const ME_PN = '972559014410:4@s.whatsapp.net';
const ME_LID = '123456789:4@lid';
const PEER_LID = '987654321@lid';
const PEER_PN = '972500000001@s.whatsapp.net';
const PAIRING_CODE = 'ABCD1234';
const QR = '2@fakeqrpayload,abc';

type Handler = (events: Partial<BaileysEventMap>) => Promise<void>;

interface FakeSocket {
  config: UserFacingSocketConfig;
  handlers: Handler[];
  user: { id: string; lid?: string } | undefined;
  requestPairingCode: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  readMessages: ReturnType<typeof vi.fn>;
  sendPresenceUpdate: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  groupMetadata: ReturnType<typeof vi.fn>;
  emit(events: Partial<BaileysEventMap>): Promise<void>;
}

function setup(opts: { pairing?: 'qr' | 'code'; store?: SessionStore } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const store =
    opts.store ??
    createSupabaseSessionStore({
      db: new InMemoryBaileysAuthStateDb(),
      accountId: 'acc-1',
      cipher: SessionCipher.fromMasterKey(randomBytes(32)),
    });
  let msgSeq = 0;
  const makeSocket = (config: UserFacingSocketConfig): BaileysSocket => {
    const s: FakeSocket = {
      config,
      handlers: [],
      user: undefined,
      requestPairingCode: vi.fn(async () => PAIRING_CODE),
      sendMessage: vi.fn(async (jid: string, content: { text?: string }) => ({
        key: { remoteJid: jid, id: `3EB0${++msgSeq}`, fromMe: true },
        message: { conversation: content.text ?? '' },
      })),
      readMessages: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      groupMetadata: vi.fn(async (id: string) => ({ id, subject: 'g', participants: [] })),
      async emit(events) {
        for (const h of this.handlers) await h(events);
      },
    };
    (s as unknown as { ev: unknown }).ev = { process: (h: Handler) => s.handlers.push(h) };
    sockets.push(s);
    return s as unknown as BaileysSocket;
  };
  const session = new BaileysSession({
    accountId: 'acc-1',
    store,
    pairing: opts.pairing === 'code' ? { mode: 'code', phoneNumber: PAIRING } : { mode: 'qr' },
    makeSocket,
    logger: createLogger({ level: 'trace', destination: dest }),
    baileysLogLevel: 'trace',
    timers: {
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => undefined,
    },
  });
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  const last = () => sockets[sockets.length - 1]!;
  const close = (statusCode?: number) =>
    last().emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: {
          error:
            statusCode === undefined
              ? undefined
              : Object.assign(new Error('x'), { output: { statusCode } }),
          date: new Date(),
        },
      },
    });
  const open = async () => {
    last().user = { id: ME_PN, lid: ME_LID };
    await last().emit({ 'connection.update': { connection: 'open' } });
  };
  return { session, sockets, timers, events, logs, store, last, close, open };
}

async function registeredStore(): Promise<SessionStore> {
  const store = createSupabaseSessionStore({
    db: new InMemoryBaileysAuthStateDb(),
    accountId: 'acc-1',
    cipher: SessionCipher.fromMasterKey(randomBytes(32)),
  });
  const c = initAuthCreds();
  c.registered = true;
  c.me = { id: ME_PN, lid: ME_LID };
  await store.saveCreds(c);
  return store;
}

describe('BaileysSession', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('C13 forces production-safe socket config and a real getMessage', async () => {
    await t.session.start();
    const cfg = t.last().config;
    expect(cfg.markOnlineOnConnect).toBe(false);
    expect(cfg.syncFullHistory).toBe(false);
    expect(cfg.shouldSyncHistoryMessage!({} as never)).toBe(false);
    await t.store.recordSentMessage('3EB0OWN', { conversation: 'mine' });
    expect((await cfg.getMessage!({ id: '3EB0OWN' }))?.conversation).toBe('mine');
    expect(await cfg.getMessage!({ id: 'nope' })).toBeUndefined();
  });

  it('QR mode emits qr events (persisted as session_events qr)', async () => {
    await t.session.start();
    await t.last().emit({ 'connection.update': { qr: QR } });
    const qr = t.events.find((e) => e.type === 'qr');
    expect(qr).toMatchObject({ type: 'qr', qr: QR });
    expect(sessionEventRow(qr!)).toMatchObject({ event: 'qr', code: null });
    expect(t.last().requestPairingCode).not.toHaveBeenCalled();
  });

  it('pairing-code mode requests one code per socket and never emits the QR', async () => {
    t = setup({ pairing: 'code' });
    await t.session.start();
    await t.last().emit({ 'connection.update': { qr: QR } });
    await t.last().emit({ 'connection.update': { qr: QR + '2' } });
    expect(t.last().requestPairingCode).toHaveBeenCalledTimes(1);
    expect(t.last().requestPairingCode).toHaveBeenCalledWith('972559014410');
    expect(t.events.filter((e) => e.type === 'qr')).toHaveLength(0);
    expect(t.events.find((e) => e.type === 'pairing_code')).toMatchObject({ code: PAIRING_CODE });
  });

  it('C11 never logs pairing code, QR or full JIDs', async () => {
    t = setup({ pairing: 'code' });
    await t.session.start();
    await t.last().emit({ 'connection.update': { qr: QR } });
    await t.open();
    await t.last().emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: PEER_LID, remoteJidAlt: PEER_PN, id: 'IN1' },
            message: { conversation: 'private words' },
            messageTimestamp: 1,
          },
        ],
      },
    });
    await t.session.sendText(PEER_PN, 'outgoing secret');
    const all = t.logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const s of [
      PAIRING_CODE,
      QR,
      '972559014410',
      '972500000001',
      '987654321',
      'private words',
      'outgoing secret',
    ])
      expect(all).not.toContain(s);
  });

  it('open → emits open with me (PN + LID); new login also emits relinked', async () => {
    await t.session.start();
    await t.last().emit({ 'connection.update': { isNewLogin: true } });
    await t.close(515);
    expect(t.timers.at(-1)!.ms).toBe(0); // restartRequired → immediate
    t.timers.at(-1)!.fn();
    await t.open();
    const open = t.events.find((e) => e.type === 'open')!;
    expect(open).toMatchObject({
      me: { pn: '972559014410@s.whatsapp.net', lid: '123456789@lid' },
      isNewLogin: true,
      restored: false,
    });
    expect(t.events.some((e) => e.type === 'relinked')).toBe(true);
    expect(t.session.state).toBe('open');
  });

  it('RL4 transient close → exponential backoff 1s→30s; open resets attempts', async () => {
    t = setup({ store: await registeredStore() });
    await t.session.start();
    await t.open();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await t.close(428);
      delays.push(t.timers.at(-1)!.ms);
      t.timers.at(-1)!.fn();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    await t.open();
    await t.close(408);
    expect(t.timers.at(-1)!.ms).toBe(1_000);
    const reopen = t.events.filter((e) => e.type === 'open').at(-1)!;
    expect(reopen.type === 'open' && reopen.reconnectMs).not.toBeNull();
    expect(reopen.type === 'open' && reopen.restored).toBe(true);
  });

  it('RL4 restartRequired resets backoff', async () => {
    t = setup({ store: await registeredStore() });
    await t.session.start();
    await t.close(428);
    t.timers.at(-1)!.fn();
    await t.close(428);
    expect(t.timers.at(-1)!.ms).toBe(2_000);
    t.timers.at(-1)!.fn();
    await t.close(515);
    expect(t.timers.at(-1)!.ms).toBe(0);
    t.timers.at(-1)!.fn();
    await t.close(428);
    expect(t.timers.at(-1)!.ms).toBe(1_000);
  });

  it.each([401, 500])('RL4 code %s → needs_relink, store wiped, no retry', async (code) => {
    const store = await registeredStore();
    t = setup({ store });
    await t.session.start();
    await t.open();
    const before = t.timers.length;
    await t.close(code);
    expect(t.session.state).toBe('needs_relink');
    expect(t.events.find((e) => e.type === 'needs_relink')).toMatchObject({ code });
    expect(await store.loadCreds()).toBeNull();
    expect(t.timers.length).toBe(before);
    expect(sessionEventRow(t.events.find((e) => e.type === 'close')!)).toMatchObject({
      event: 'close',
      code,
    });
  });

  it.each([440, 403])('RL4 code %s → conflict, stop, no auto-retry, store kept', async (code) => {
    const store = await registeredStore();
    t = setup({ store });
    await t.session.start();
    await t.open();
    const before = t.timers.length;
    await t.close(code);
    expect(t.session.state).toBe('conflict');
    const c = t.events.find((e) => e.type === 'conflict')!;
    expect(sessionEventRow(c)).toMatchObject({ event: 'conflict', code });
    expect(t.timers.length).toBe(before);
    expect(await store.loadCreds()).not.toBeNull();
  });

  it('gives up pairing after maxPairingAttempts unregistered sockets', async () => {
    t = setup({ pairing: 'code' });
    await t.session.start();
    for (let i = 0; i < 3; i++) {
      await t.close(408);
      t.timers.at(-1)!.fn();
    }
    expect(t.sockets).toHaveLength(3);
    expect(t.events.find((e) => e.type === 'pairing_expired')).toMatchObject({ attempts: 3 });
  });

  it('close() stops without reconnecting and without wiping', async () => {
    const store = await registeredStore();
    t = setup({ store });
    await t.session.start();
    await t.open();
    await t.session.close();
    await t.close(428);
    expect(t.last().end).toHaveBeenCalled();
    expect(t.session.state).toBe('closed');
    expect(await store.loadCreds()).not.toBeNull();
    expect(t.events.at(-1)).toMatchObject({ type: 'close', action: 'stopped' });
  });

  it('logout() unlinks and wipes the store', async () => {
    const store = await registeredStore();
    t = setup({ store });
    await t.session.start();
    await t.open();
    await t.session.logout();
    expect(t.last().logout).toHaveBeenCalled();
    expect(await store.loadCreds()).toBeNull();
    expect(t.session.state).toBe('needs_relink');
  });

  it('messages.upsert → normalised message; CIPHERTEXT stub → decrypt_failure', async () => {
    await t.session.start();
    await t.open();
    await t.last().emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: PEER_LID, remoteJidAlt: PEER_PN, id: 'IN1' },
            message: { conversation: 'hi' },
            messageTimestamp: 1,
          },
          {
            key: { remoteJid: PEER_LID, id: 'IN2' },
            messageStubType: 2,
            messageStubParameters: ['No session'],
            messageTimestamp: 1,
          },
        ],
      },
    });
    const m = t.events.find((e) => e.type === 'message');
    expect(m?.type === 'message' && m.event).toMatchObject({
      providerMessageId: 'IN1',
      senderPn: PEER_PN,
      senderLid: PEER_LID,
      text: 'hi',
    });
    expect(t.events.find((e) => e.type === 'decrypt_failure')).toMatchObject({
      providerMessageId: 'IN2',
      chatKind: 'lid',
    });
  });

  it('messages.update → status events for own messages', async () => {
    await t.session.start();
    await t.last().emit({
      'messages.update': [
        { key: { remoteJid: PEER_LID, id: 'OUT1', fromMe: true }, update: { status: 3 } },
      ],
    });
    expect(t.events.find((e) => e.type === 'status')).toMatchObject({
      update: { providerMessageId: 'OUT1', status: 'delivered' },
    });
  });

  it('sendMessage records the sent message for getMessage; requires open', async () => {
    await t.session.start();
    await expect(t.session.sendText(PEER_PN, 'x')).rejects.toThrow(/session_not_open/);
    await t.open();
    const { id } = await t.session.sendText(PEER_PN, 'hello');
    expect((await t.store.getSentMessage(id))?.conversation).toBe('hello');
    expect((await t.last().config.getMessage!({ id }))?.conversation).toBe('hello');
  });

  it('quoting uses the inbound cache or own sent messages; unknown quoted id rejects', async () => {
    await t.session.start();
    await t.open();
    await t.last().emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: PEER_LID, id: 'IN9' },
            message: { conversation: 'q' },
            messageTimestamp: 1,
          },
        ],
      },
    });
    await t.session.sendText(PEER_LID, 'reply', { quotedId: 'IN9' });
    expect(t.last().sendMessage.mock.calls.at(-1)![2].quoted.key.id).toBe('IN9');
    await expect(t.session.sendText(PEER_LID, 'r', { quotedId: 'UNKNOWN' })).rejects.toThrow(
      /quoted_message_unknown/,
    );
  });

  it('group sends populate cachedGroupMetadata', async () => {
    await t.session.start();
    await t.open();
    await t.session.sendText('120363000000000001@g.us', 'hi');
    expect(t.last().groupMetadata).toHaveBeenCalledTimes(1);
    expect(await t.last().config.cachedGroupMetadata!('120363000000000001@g.us')).toMatchObject({
      id: '120363000000000001@g.us',
    });
    await t.session.sendText('120363000000000001@g.us', 'again');
    expect(t.last().groupMetadata).toHaveBeenCalledTimes(1);
  });

  it('markRead uses cached inbound keys (with participant) and presence passes through', async () => {
    await t.session.start();
    await t.open();
    await t.session.markRead(PEER_LID, ['A1']);
    expect(t.last().readMessages).toHaveBeenCalledWith([
      { remoteJid: PEER_LID, id: 'A1', fromMe: false },
    ]);
    await t.session.presence(PEER_LID, 'composing');
    expect(t.last().sendPresenceUpdate).toHaveBeenCalledWith('composing', PEER_LID);
  });

  it('creds.update persists creds', async () => {
    await t.session.start();
    await t.last().emit({ 'creds.update': { registered: false } });
    expect(await t.store.loadCreds()).not.toBeNull();
  });
});
