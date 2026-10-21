import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_ACK_TEXT } from '@htz/relay';
import { createOutbox } from '../queue/outbox';
import {
  ACC,
  FakeDb,
  FakeSession,
  TARGET,
  TZVI_E164,
  TZVI_PN,
  silentLogger,
  uuid,
} from '../test/fakes';
import { TranscriberError, type Transcriber } from '../transcribe/transcriber';
import { RelayChannel, TRANSCRIPT_FAILED_TEXT, type AcceptedRelayMessage } from './relay-channel';

const CONV = '00000000-0000-4000-8000-0000000000c1';

function setup(transcribe?: Transcriber['transcribe']) {
  const db = new FakeDb();
  db.conversations.set(CONV, {
    id: CONV,
    account_id: ACC,
    chat_jid: TZVI_PN,
    type: 'direct',
    last_inbound_at: null,
  });
  const session = new FakeSession(ACC);
  session.state = 'open';
  const transcriber: Transcriber = {
    name: 'fake',
    transcribe: vi.fn(
      transcribe ?? (async () => ({ text: 'שלום', durationS: 2, elapsedMs: 5, backend: 'fake' })),
    ),
  };
  const media = {
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => new Uint8Array([7])),
  };
  const ch = new RelayChannel({
    accountId: ACC,
    relayTargetId: TARGET,
    debounceMs: 4000,
    db,
    session: () => session,
    outbox: createOutbox({ db, wake: () => undefined, log: silentLogger() }),
    transcriber,
    media,
    log: silentLogger(),
    transcribeRetryDelayMs: 0,
    sleep: async () => undefined,
  });
  return { db, session, ch, transcriber, media };
}

function msg(over: Partial<AcceptedRelayMessage> = {}): AcceptedRelayMessage {
  return {
    messageId: uuid(),
    providerMessageId: `WA${uuid().slice(-4)}`,
    conversationId: CONV,
    chatJid: TZVI_PN,
    fromE164: TZVI_E164,
    timestamp: new Date().toISOString(),
    type: 'text',
    text: 'היי',
    replyToId: null,
    isForwarded: false,
    voiceSeconds: null,
    audio: null,
    mediaPath: null,
    mediaMime: null,
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('RelayChannel (L3)', () => {
  it('L3.1 three texts within 4 s → one batch; read + typing shown right away and kept alive', async () => {
    const t = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = msg();
      ids.push(m.messageId);
      t.ch.accept(m);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(t.session.callsOf('markRead')).toHaveLength(3);
    expect(t.session.callsOf('presence')[0]).toEqual([TZVI_PN, 'composing']);
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await t.ch.drain();
    const b = t.db.callsOf('createRelayBatch');
    expect(b).toHaveLength(1);
    expect(b[0]?.[0]).toBe(TARGET);
    expect(b[0]?.[1]).toEqual(ids);
    expect(b[0]?.[2]).toBe(CONV);
    expect(typeof b[0]?.[4]).toBe('string'); // debouncer batch_id passed as p_batch_id
  });

  it('L3.1 composing is kept alive while a long voice batch stays open', async () => {
    const t = setup(() => new Promise(() => undefined)); // transcription never finishes
    t.ch.accept(
      msg({
        type: 'voice',
        voiceSeconds: 90,
        audio: { bytes: new Uint8Array([1]), mime: 'audio/ogg' },
      }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const composing = t.session.callsOf('presence').filter((c) => c[1] === 'composing');
    expect(composing.length).toBeGreaterThanOrEqual(2);
  });

  it('L3.2 messages 4.1 s apart → two batches, in order', async () => {
    const t = setup();
    const a = msg();
    t.ch.accept(a);
    await vi.advanceTimersByTimeAsync(4_100);
    const b = msg();
    t.ch.accept(b);
    await vi.advanceTimersByTimeAsync(4_100);
    await t.ch.drain();
    const calls = t.db.callsOf('createRelayBatch');
    expect(calls.map((c) => c[1])).toEqual([[a.messageId], [b.messageId]]);
    expect(calls[0]?.[4]).not.toBe(calls[1]?.[4]);
  });

  it('L3.3 restart mid-window: pending messages re-batched on boot, none lost or duplicated', async () => {
    const t = setup();
    const now = Date.now();
    t.db.pending = [
      {
        id: 'm-2',
        conversation_id: CONV,
        kind: 'text',
        body: 'b',
        sender_jid: TZVI_PN,
        media_path: null,
        media_mime: null,
        media_seconds: null,
        transcript: null,
        transcript_ready_at: null,
        quoted_provider_id: null,
        is_forwarded: false,
        received_at: new Date(now - 1_000).toISOString(),
        created_at: new Date(now).toISOString(),
      },
      {
        id: 'm-1',
        conversation_id: CONV,
        kind: 'text',
        body: 'a',
        sender_jid: TZVI_PN,
        media_path: null,
        media_mime: null,
        media_seconds: null,
        transcript: null,
        transcript_ready_at: null,
        quoted_provider_id: null,
        is_forwarded: false,
        received_at: new Date(now - 2_000).toISOString(),
        created_at: new Date(now).toISOString(),
      },
    ];
    expect(await t.ch.recover()).toBe(2);
    // A re-delivered copy of a pending message after boot is dropped by the Debouncer.
    t.ch.accept(msg({ messageId: 'm-1' }));
    await vi.advanceTimersByTimeAsync(4_100);
    await t.ch.drain();
    const calls = t.db.callsOf('createRelayBatch');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(['m-1', 'm-2']);
  });

  it('L3.3 recovered voice without transcript is re-transcribed from Storage', async () => {
    const t = setup();
    t.db.pending = [
      {
        id: 'v-1',
        conversation_id: CONV,
        kind: 'voice',
        body: null,
        sender_jid: TZVI_PN,
        media_path: 'o/a/v',
        media_mime: 'audio/ogg',
        media_seconds: 4,
        transcript: null,
        transcript_ready_at: null,
        quoted_provider_id: null,
        is_forwarded: false,
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ];
    await t.ch.recover();
    await vi.advanceTimersByTimeAsync(4_100);
    await t.ch.drain();
    expect(t.media.download).toHaveBeenCalledWith('o/a/v');
    expect(t.db.callsOf('setTranscript')[0]).toEqual(['v-1', 'שלום']);
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(1);
  });

  it('L3.7 transcriber killed mid-job: retry once, then transcript null + plain explanation to Tzvi; audio kept', async () => {
    const t = setup(async () => {
      throw new TranscriberError('local', 'ECONNREFUSED');
    });
    const voice = msg({
      type: 'voice',
      voiceSeconds: 10,
      audio: { bytes: new Uint8Array([1, 2]), mime: 'audio/ogg' },
      mediaPath: 'o/a/x',
    });
    t.ch.accept(voice);
    await vi.advanceTimersByTimeAsync(4_100);
    await t.ch.drain();
    expect(t.transcriber.transcribe).toHaveBeenCalledTimes(2);
    expect(t.db.callsOf('setTranscript')).toHaveLength(0);
    expect(t.db.enqueued.map((e) => e.p_body)).toContain(TRANSCRIPT_FAILED_TEXT);
    expect(t.db.callsOf('createRelayBatch')[0]?.[1]).toEqual([voice.messageId]);
    expect(t.media.upload).not.toHaveBeenCalled(); // nothing deleted/overwritten; audio stays where ingest put it
  });

  it('L3.4 transcript over the 30 s cap → batch goes with transcript null, then a follow-up event with the same message_id', async () => {
    let finish: (v: {
      text: string;
      durationS: number;
      elapsedMs: number;
      backend: string;
    }) => void = () => undefined;
    const t = setup(() => new Promise((r) => (finish = r)));
    const voice = msg({
      type: 'voice',
      voiceSeconds: 40,
      audio: { bytes: new Uint8Array([1]), mime: 'audio/ogg' },
    });
    t.ch.accept(voice);
    await vi.advanceTimersByTimeAsync(35_000);
    await vi.advanceTimersByTimeAsync(0);
    const batch = t.db.callsOf('createRelayBatch')[0];
    expect(batch?.[1]).toEqual([voice.messageId]);
    expect(t.db.callsOf('relayTranscriptFollowup')).toHaveLength(0);
    finish({ text: 'תמליל', durationS: 40, elapsedMs: 1, backend: 'fake' });
    await vi.advanceTimersByTimeAsync(0);
    await t.ch.drain();
    expect(t.db.callsOf('relayTranscriptFollowup')).toEqual([
      [batch?.[4], voice.messageId, 'תמליל'],
    ]);
  });

  it('L3.5 voice >60 s: Gateway replies "receiving, transcribing" once per batch; Lia woken only when the transcript is ready', async () => {
    let finish: (v: {
      text: string;
      durationS: number;
      elapsedMs: number;
      backend: string;
    }) => void = () => undefined;
    const t = setup(() => new Promise((r) => (finish = r)));
    t.ch.accept(
      msg({
        type: 'voice',
        voiceSeconds: 120,
        audio: { bytes: new Uint8Array([1]), mime: 'audio/ogg' },
      }),
    );
    t.ch.accept(
      msg({
        type: 'voice',
        voiceSeconds: 90,
        audio: { bytes: new Uint8Array([1]), mime: 'audio/ogg' },
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    expect(t.db.enqueued.filter((e) => e.p_body === VOICE_ACK_TEXT)).toHaveLength(1);
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(0);
    finish({ text: 'א', durationS: 120, elapsedMs: 1, backend: 'fake' });
    await vi.advanceTimersByTimeAsync(0);
    finish({ text: 'ב', durationS: 90, elapsedMs: 1, backend: 'fake' });
    await vi.advanceTimersByTimeAsync(0);
    await t.ch.drain();
    expect(t.db.callsOf('createRelayBatch')).toHaveLength(1);
  });
});
