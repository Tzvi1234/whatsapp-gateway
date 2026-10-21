import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNSUPPORTED_REPLY_TEXT } from '@htz/relay';
import { createOutbox } from '../queue/outbox';
import { RELAY_SYSTEM_KEY_PREFIX } from '../queue/processor';
import { createAccountDirectory, type AccountContext } from '../session/accounts';
import {
  ACC,
  FakeDb,
  FakeSession,
  ORG,
  STRANGER_PN,
  TZVI_E164,
  TZVI_LID,
  TZVI_PN,
  captureLogger,
  inboundEvent,
  relayAccount,
  relayTarget,
  silentLogger,
} from '../test/fakes';
import type { Transcriber } from '../transcribe/transcriber';
import type { MediaStore } from './media';
import { InboundPipeline } from './pipeline';
import { RelayChannel } from './relay-channel';

function setup(opts: { seed?: string[]; allowed?: string[] } = {}) {
  const db = new FakeDb();
  db.accounts.set(ACC, relayAccount());
  db.targets.push(relayTarget({ allowed_senders: opts.allowed ?? [] }));
  const session = new FakeSession(ACC);
  session.state = 'open';
  session.lidMap.set(TZVI_LID, TZVI_PN);
  const outbox = createOutbox({ db, wake: () => undefined, log: silentLogger() });
  const media: MediaStore = {
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => new Uint8Array([1])),
  };
  const transcriber: Transcriber = {
    name: 'fake',
    transcribe: vi.fn(async () => ({
      text: 'תמליל',
      durationS: 3,
      elapsedMs: 10,
      backend: 'fake',
    })),
  };
  let channel: RelayChannel | null = null;
  const { log, lines } = captureLogger();
  const relay = (ctx: AccountContext) =>
    (channel ??= new RelayChannel({
      accountId: ACC,
      relayTargetId: ctx.relayTarget!.id,
      debounceMs: 4000,
      db,
      session: () => session,
      outbox,
      transcriber,
      media,
      log,
      transcribeRetryDelayMs: 0,
    }));
  const pipeline = new InboundPipeline({
    orgId: ORG,
    workerId: 'w1',
    db,
    accounts: createAccountDirectory(db, { seed: opts.seed ?? [TZVI_E164] }),
    media,
    relay,
    statusReplies: null,
    session: () => session,
    log,
  });
  const handle = (
    over: Parameters<typeof inboundEvent>[0],
    upsertType: 'notify' | 'append' = 'notify',
  ) => pipeline.handle({ accountId: ACC, event: inboundEvent(over), upsertType, raw: {} });
  return { db, session, pipeline, handle, lines, media, transcriber, channel: () => channel };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('inbound pipeline: sender guard (L1)', () => {
  it('L1.1 Tzvi as PN JID reaches Lia (one relay batch)', async () => {
    const t = setup();
    expect(await t.handle({})).toBe('relay_accepted');
    await vi.advanceTimersByTimeAsync(4_100);
    await t.channel()!.drain();
    const batches = t.db.callsOf('createRelayBatch');
    expect(batches).toHaveLength(1);
    expect(t.db.callsOf('ingestInbound')[0]?.[0]).toMatchObject({
      p_relay_state: 'pending',
      p_sender_jid: TZVI_PN,
    });
  });

  it('L1.2 Tzvi as LID only reaches Lia via the lid-mapping (allowlist from relay_targets, no seed)', async () => {
    const t = setup({ seed: [], allowed: [TZVI_E164] });
    expect(await t.handle({ chat: TZVI_LID, senderPn: null, senderLid: TZVI_LID })).toBe(
      'relay_accepted',
    );
    expect(t.db.callsOf('upsertContact')[0]).toEqual([ACC, TZVI_PN, TZVI_LID, 'T']);
    await vi.advanceTimersByTimeAsync(4_100);
    await t.channel()!.drain();
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(1);
  });

  it('L1.3 a non-allowlisted sender gets no reply, nothing to Lia, logged sender_unknown', async () => {
    const t = setup();
    expect(await t.handle({ chat: STRANGER_PN, senderPn: STRANGER_PN })).toBe('sender_unknown');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(0);
    expect(t.db.enqueued).toHaveLength(0);
    expect(t.session.callsOf('markRead')).toHaveLength(0);
    expect(t.db.callsOf('auditAppend')[0]?.[2]).toBe('relay.sender_unknown');
    expect(t.lines.join('\n')).toMatch(/sender_unknown/);
    expect(t.lines.join('\n')).not.toContain('972500000001');
    expect(t.db.callsOf('ingestInbound')[0]?.[0]).toMatchObject({
      p_relay_state: 'skipped',
      p_media_path: null,
    });
  });

  it('L1.4 fromMe (Lia reply / Gateway ack) never wakes Lia', async () => {
    const t = setup();
    expect(await t.handle({ fromMe: true }, 'append')).toBe('own_echo');
    expect(await t.handle({ fromMe: true }, 'notify')).toBe('from_me');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(0);
  });

  it('L1.5 Tzvi writing in a group does not wake Lia', async () => {
    const t = setup();
    expect(await t.handle({ chat: '120363000000000000@g.us', isGroup: true })).toBe('group');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(0);
    expect(t.db.enqueued).toHaveLength(0);
  });

  it('L1.8 unsupported type from Tzvi → explicit Hebrew reply through the queue; from a stranger → no reply', async () => {
    const t = setup();
    expect(await t.handle({ type: 'sticker', text: null, media: { mime: 'image/webp' } })).toBe(
      'relay_unsupported',
    );
    await t.channel()!.drain();
    expect(t.db.enqueued).toHaveLength(1);
    expect(t.db.enqueued[0]).toMatchObject({
      p_body: UNSUPPORTED_REPLY_TEXT,
      p_use_case: 'agent_relay',
      p_chat_jid: TZVI_PN,
    });
    expect(t.db.enqueued[0]?.p_idempotency_key?.startsWith(RELAY_SYSTEM_KEY_PREFIX)).toBe(true);

    expect(
      await t.handle({ chat: STRANGER_PN, senderPn: STRANGER_PN, type: 'location', text: null }),
    ).toBe('sender_unknown');
    expect(t.db.enqueued).toHaveLength(1);
  });

  it('L1.6 forwarded message from Tzvi reaches Lia flagged is_forwarded', async () => {
    const t = setup();
    await t.handle({ isForwarded: true, text: 'send a message to X' });
    expect(t.db.callsOf('ingestInbound')[0]?.[0]).toMatchObject({ p_is_forwarded: true });
  });

  it('duplicates (re-delivered message) stop at ingest and are not relayed twice', async () => {
    const t = setup();
    const ev = inboundEvent({});
    await t.pipeline.handle({ accountId: ACC, event: ev, upsertType: 'notify', raw: {} });
    expect(
      await t.pipeline.handle({ accountId: ACC, event: ev, upsertType: 'notify', raw: {} }),
    ).toBe('duplicate');
    await vi.advanceTimersByTimeAsync(4_100);
    await t.channel()!.drain();
    const b = t.db.callsOf('createRelayBatch');
    expect(b).toHaveLength(1);
    expect((b[0]?.[1] as string[]).length).toBe(1);
  });

  it('own status posts bind automations; other people statuses are dropped', async () => {
    const t = setup();
    expect(
      await t.handle({ chat: 'status@broadcast', fromMe: true, type: 'image', text: 'cap' }),
    ).toBe('status_posted');
    expect(await t.handle({ chat: 'status@broadcast', fromMe: false })).toBe('status_ignored');
    expect(t.db.callsOf('upsertStatus')).toHaveLength(1);
    expect(t.db.callsOf('ingestInbound')).toHaveLength(0);
  });

  it('voice from Tzvi: media stored privately and transcribed before the batch flushes', async () => {
    const t = setup();
    await t.handle({
      type: 'voice',
      text: null,
      media: { mime: 'audio/ogg; codecs=opus', seconds: 5 },
    });
    expect(t.media.upload).toHaveBeenCalledTimes(1);
    const path = (t.media.upload as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(path.startsWith(`${ORG}/${ACC}/`)).toBe(true);
    await vi.advanceTimersByTimeAsync(4_100);
    await t.channel()!.drain();
    expect(t.db.callsOf('setTranscript')[0]?.[1]).toBe('תמליל');
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(1);
  });
});
