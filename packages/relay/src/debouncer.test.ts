import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampDebounceMs,
  Debouncer,
  type DebouncerCallbacks,
  type FlushedBatch,
} from './debouncer';
import { UNSUPPORTED_REPLY_TEXT, VOICE_ACK_TEXT, type RelayInboundMessage } from './payload';

const T0 = Date.parse('2026-10-21T12:00:00.000Z');
let seq = 0;

function msg(over: Partial<RelayInboundMessage> = {}): RelayInboundMessage {
  seq += 1;
  return {
    messageId: `m${seq}`,
    threadId: 'thread-owner',
    from: '+972559014410',
    timestamp: new Date(T0 + seq * 1000).toISOString(),
    type: 'text',
    text: `hello ${seq}`,
    mediaUrl: null,
    replyToId: null,
    isForwarded: false,
    ...over,
  };
}

function harness(opts: ConstructorParameters<typeof Debouncer>[1] = {}) {
  const events: string[] = [];
  const flushed: FlushedBatch[] = [];
  const followUps: unknown[] = [];
  let n = 0;
  const cb: DebouncerCallbacks = {
    onFirstMessage: (t) => events.push(`first:${t}`),
    onKeepAlive: (t) => events.push(`keepalive:${t}`),
    onFlush: (b) => {
      events.push(`flush:${b.batchId}`);
      flushed.push(b);
    },
    onVoiceAck: (_t, b, text) => events.push(`ack:${b}:${text}`),
    onUnsupported: (_t, id, text) => events.push(`unsupported:${id}:${text}`),
    onTranscriptFollowUp: (_t, e) => followUps.push(e),
  };
  const d = new Debouncer(cb, { batchId: () => `b${++n}`, ...opts });
  return { d, events, flushed, followUps };
}

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
});
afterEach(() => vi.useRealTimers());

describe('Debouncer', () => {
  it('L3.1 three texts within 4s become one batch; read+typing right away and kept alive', () => {
    const h = harness({ keepAliveMs: 2_000 });
    h.d.add(msg());
    expect(h.events).toEqual(['first:thread-owner']);
    vi.advanceTimersByTime(1_500);
    h.d.add(msg());
    vi.advanceTimersByTime(1_500);
    h.d.add(msg());
    expect(h.events).toContain('keepalive:thread-owner');
    vi.advanceTimersByTime(3_999);
    expect(h.flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.flushed).toHaveLength(1);
    expect(h.flushed[0]!.messageIds).toEqual(['m1', 'm2', 'm3']);
    expect(h.events.filter((e) => e.startsWith('first'))).toHaveLength(1);
    const keepAlives = h.events.filter((e) => e.startsWith('keepalive')).length;
    vi.advanceTimersByTime(20_000);
    expect(h.events.filter((e) => e.startsWith('keepalive')).length).toBe(keepAlives);
  });

  it('L3.2 messages 4.1s apart become two batches, in order', () => {
    const h = harness();
    h.d.add(msg());
    vi.advanceTimersByTime(4_100);
    h.d.add(msg());
    vi.advanceTimersByTime(4_100);
    expect(h.flushed.map((b) => [b.batchId, b.messageIds])).toEqual([
      ['b1', ['m1']],
      ['b2', ['m2']],
    ]);
  });

  it('debounce is configurable within 3-5s and clamped outside', () => {
    expect(clampDebounceMs(undefined)).toBe(4_000);
    expect(clampDebounceMs(1_000)).toBe(3_000);
    expect(clampDebounceMs(9_000)).toBe(5_000);
    const h = harness({ debounceMs: 3_000 });
    h.d.add(msg());
    vi.advanceTimersByTime(3_000);
    expect(h.flushed).toHaveLength(1);
  });

  it('L3.4 short voice: batch waits for the transcript, then sends', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 20 }));
    vi.advanceTimersByTime(10_000);
    expect(h.flushed).toHaveLength(0);
    expect(h.d.setTranscript('m1', 'שלום')).toBe('applied');
    expect(h.flushed).toHaveLength(1);
    expect(h.flushed[0]!.messages[0]).toMatchObject({ type: 'voice', transcript: 'שלום' });
  });

  it('L3.4 short voice over the 30s cap: transcript null, then follow-up with same message_id', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 45 }));
    h.d.add(msg());
    vi.advanceTimersByTime(29_999);
    expect(h.flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.flushed).toHaveLength(1);
    const b = h.flushed[0]!;
    expect(b.messages.map((m) => [m.message_id, m.transcript])).toEqual([
      ['m1', null],
      ['m2', null],
    ]);
    // Lia may already have replied; the follow-up is still emitted
    expect(h.d.setTranscript('m1', 'מאוחר')).toBe('followup');
    expect(h.followUps).toEqual([
      { event: 'transcript', batch_id: b.batchId, message_id: 'm1', transcript: 'מאוחר' },
    ]);
    expect(h.d.setTranscript('m1', 'again')).toBe('unknown');
  });

  it('L3.5 voice >60s: one ack per batch, Lia not woken until the transcript is ready', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 120 }));
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 90 }));
    expect(h.events.filter((e) => e.startsWith('ack'))).toEqual([`ack:b1:${VOICE_ACK_TEXT}`]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.flushed).toHaveLength(0);
    h.d.setTranscript('m1', 'one');
    expect(h.flushed).toHaveLength(0);
    h.d.setTranscript('m2', 'two');
    expect(h.flushed).toHaveLength(1);
    expect(h.flushed[0]!.messages.map((m) => m.transcript)).toEqual(['one', 'two']);
  });

  it('L3.5 a new batch gets its own ack', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 120 }));
    h.d.setTranscript('m1', 'x');
    vi.advanceTimersByTime(4_000);
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 120 }));
    expect(h.events.filter((e) => e.startsWith('ack'))).toEqual([
      `ack:b1:${VOICE_ACK_TEXT}`,
      `ack:b2:${VOICE_ACK_TEXT}`,
    ]);
  });

  it('L3.7 transcriber failure (null) releases a long-voice batch', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 120 }));
    vi.advanceTimersByTime(5_000);
    h.d.setTranscript('m1', null);
    expect(h.flushed[0]!.messages[0]!.transcript).toBeNull();
  });

  it('L3.6 several voice notes, short one finishes first: delivered in send order, one batch', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 50 }));
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 5 }));
    h.d.add(msg({ type: 'text', text: 'and text' }));
    vi.advanceTimersByTime(4_000);
    h.d.setTranscript('m2', 'short');
    expect(h.flushed).toHaveLength(0);
    h.d.setTranscript('m1', 'long');
    expect(h.flushed).toHaveLength(1);
    expect(h.flushed[0]!.messages.map((m) => [m.message_id, m.transcript])).toEqual([
      ['m1', 'long'],
      ['m2', 'short'],
      ['m3', null],
    ]);
  });

  it('L3.4 transcript arriving before the debounce ends does not flush early', () => {
    const h = harness();
    h.d.add(msg({ type: 'voice', text: null, voiceSeconds: 5 }));
    h.d.setTranscript('m1', 'fast');
    expect(h.flushed).toHaveLength(0);
    vi.advanceTimersByTime(4_000);
    expect(h.flushed).toHaveLength(1);
  });

  it.each(['sticker', 'location', 'contact', 'poll', 'view_once'] as const)(
    'L1.8 unsupported %s gets the explicit reply and is not relayed',
    (type) => {
      const h = harness();
      expect(h.d.add(msg({ type }))).toBe('unsupported');
      expect(h.events).toEqual([`unsupported:m1:${UNSUPPORTED_REPLY_TEXT}`]);
      vi.advanceTimersByTime(10_000);
      expect(h.flushed).toHaveLength(0);
    },
  );

  it('reactions are ignored silently; duplicates are dropped', () => {
    const h = harness();
    expect(h.d.add(msg({ type: 'reaction' }))).toBe('ignored');
    const m = msg();
    expect(h.d.add(m)).toBe('batched');
    expect(h.d.add(m)).toBe('duplicate');
    vi.advanceTimersByTime(4_000);
    expect(h.flushed[0]!.messageIds).toEqual([m.messageId]);
  });

  it('L3.3 worker restart mid-window: pending messages re-batched on boot, none lost or duplicated', () => {
    const before = harness();
    const pending = [msg(), msg(), msg()];
    for (const p of pending) before.d.add(p);
    vi.advanceTimersByTime(2_000);
    before.d.dispose(); // crash: nothing flushed
    expect(before.flushed).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(before.flushed).toHaveLength(0);

    const after = harness();
    // DB returns them out of order and one twice
    const results = after.d.restore([pending[2]!, pending[0]!, pending[1]!, pending[0]!]);
    expect(results.filter((r) => r === 'batched')).toHaveLength(3);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(1);
    vi.advanceTimersByTime(4_000);
    expect(after.flushed).toHaveLength(1);
    expect(after.flushed[0]!.messageIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('L3.3 restore keeps a known final transcript and waits for missing ones', () => {
    const h = harness();
    h.d.restore([
      msg({ type: 'voice', text: null, voiceSeconds: 10, transcript: 'done' }),
      msg({ type: 'voice', text: null, voiceSeconds: 10 }),
    ]);
    vi.advanceTimersByTime(4_000);
    expect(h.flushed).toHaveLength(0);
    h.d.setTranscript('m2', 'now');
    expect(h.flushed[0]!.messages.map((m) => m.transcript)).toEqual(['done', 'now']);
  });

  it('threads are independent', () => {
    const h = harness();
    h.d.add(msg({ threadId: 'a' }));
    vi.advanceTimersByTime(2_000);
    h.d.add(msg({ threadId: 'b' }));
    expect(h.d.openThreads().sort()).toEqual(['a', 'b']);
    vi.advanceTimersByTime(2_000);
    expect(h.flushed.map((b) => b.threadId)).toEqual(['a']);
    vi.advanceTimersByTime(2_000);
    expect(h.flushed.map((b) => b.threadId)).toEqual(['a', 'b']);
  });
});
