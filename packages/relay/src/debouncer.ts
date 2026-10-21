import {
  RELAY_DEFAULT_DEBOUNCE_MS,
  RELAY_TRANSCRIPT_CAP_MS,
  VOICE_LONG_THRESHOLD_S,
  type RelayMessage,
  type RelayTranscriptEvent,
} from '@htz/core';
import {
  buildTranscriptEvent,
  newBatchId,
  routeInboundType,
  toRelayMessage,
  UNSUPPORTED_REPLY_TEXT,
  VOICE_ACK_TEXT,
  type RelayInboundMessage,
} from './payload';

export type TimerHandle = unknown;

/** Injected timers so the worker owns real time and tests stay deterministic. */
export interface DebouncerTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface FlushedBatch {
  threadId: string;
  batchId: string;
  messageIds: string[];
  messages: RelayMessage[];
}

export interface DebouncerCallbacks {
  /** First message of a new batch: worker marks read + sets presence "composing" at once. */
  onFirstMessage(threadId: string): void;
  /** Periodic tick while a batch is open: worker re-sends "composing". */
  onKeepAlive(threadId: string): void;
  /** Batch ready: worker inserts `relay_batches` (wakes Lia). */
  onFlush(batch: FlushedBatch): void;
  /** Voice >60s: Gateway replies this text itself, once per batch; Lia is not woken yet. */
  onVoiceAck(threadId: string, batchId: string, text: string): void;
  /** Unsupported type: Gateway replies this text; message is not relayed. */
  onUnsupported(threadId: string, messageId: string, text: string): void;
  /** Transcript that arrived after its batch was flushed with `transcript: null`. */
  onTranscriptFollowUp(threadId: string, event: RelayTranscriptEvent): void;
}

export interface DebouncerOptions {
  /** Default 4000; clamped to 3000–5000. */
  debounceMs?: number;
  /** Presence keep-alive period. Default 8000. */
  keepAliveMs?: number;
  /** Max wait for a short (≤60s) voice transcript. Default 30000. */
  transcriptCapMs?: number;
  longVoiceSeconds?: number;
  timers?: DebouncerTimers;
  batchId?: () => string;
}

export type AddResult = 'batched' | 'unsupported' | 'ignored' | 'duplicate';
export type TranscriptResult = 'applied' | 'followup' | 'unknown';

interface Item {
  msg: RelayInboundMessage;
  transcript: string | null;
  /** Voice still waiting for a transcript. */
  waiting: boolean;
  longVoice: boolean;
  capped: boolean;
  capTimer: TimerHandle | null;
}

interface OpenBatch {
  threadId: string;
  batchId: string;
  items: Item[];
  quiet: boolean;
  ackSent: boolean;
  debounceTimer: TimerHandle | null;
  keepAliveTimer: TimerHandle | null;
}

const SEEN_LIMIT = 5_000;

export const clampDebounceMs = (ms: number | undefined): number =>
  Math.min(5_000, Math.max(3_000, ms ?? RELAY_DEFAULT_DEBOUNCE_MS));

const defaultTimers: DebouncerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Per-thread debounce for the agent relay (ARCH §4.7, ADR-6, TEST-PLAN L3.1-L3.6).
 * I/O-free: every side effect is a callback. One open batch per thread; each new message
 * restarts the debounce timer; the batch flushes once the thread is quiet AND no voice note
 * is still waiting for its transcript (short voice: up to the 30s cap, long voice: until ready).
 */
export class Debouncer {
  private readonly open = new Map<string, OpenBatch>();
  private readonly itemThread = new Map<string, string>();
  /** messageId → {threadId, batchId} for voice flushed with transcript null (cap hit). */
  private readonly followUps = new Map<string, { threadId: string; batchId: string }>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly debounceMs: number;
  private readonly keepAliveMs: number;
  private readonly capMs: number;
  private readonly longVoiceS: number;
  private readonly timers: DebouncerTimers;
  private readonly mintBatchId: () => string;

  constructor(
    private readonly cb: DebouncerCallbacks,
    opts: DebouncerOptions = {},
  ) {
    this.debounceMs = clampDebounceMs(opts.debounceMs);
    this.keepAliveMs = opts.keepAliveMs ?? 8_000;
    this.capMs = opts.transcriptCapMs ?? RELAY_TRANSCRIPT_CAP_MS;
    this.longVoiceS = opts.longVoiceSeconds ?? VOICE_LONG_THRESHOLD_S;
    this.timers = opts.timers ?? defaultTimers;
    this.mintBatchId = opts.batchId ?? newBatchId;
  }

  /** Feed one allowlisted inbound message. */
  add(msg: RelayInboundMessage): AddResult {
    if (this.seen.has(msg.messageId)) return 'duplicate';
    const route = routeInboundType(msg.type);
    if ('ignored' in route) return 'ignored';
    this.remember(msg.messageId);
    if ('unsupported' in route) {
      this.cb.onUnsupported(msg.threadId, msg.messageId, UNSUPPORTED_REPLY_TEXT);
      return 'unsupported';
    }

    let batch = this.open.get(msg.threadId);
    if (!batch) {
      batch = {
        threadId: msg.threadId,
        batchId: this.mintBatchId(),
        items: [],
        quiet: false,
        ackSent: false,
        debounceTimer: null,
        keepAliveTimer: null,
      };
      this.open.set(msg.threadId, batch);
      this.cb.onFirstMessage(msg.threadId);
      this.scheduleKeepAlive(batch);
    }

    const isVoice = msg.type === 'voice';
    const hasFinalTranscript = msg.transcript !== undefined;
    const item: Item = {
      msg,
      transcript: msg.transcript ?? null,
      waiting: isVoice && !hasFinalTranscript,
      longVoice: isVoice && (msg.voiceSeconds ?? 0) > this.longVoiceS,
      capped: false,
      capTimer: null,
    };
    batch.items.push(item);
    this.itemThread.set(msg.messageId, msg.threadId);

    if (item.waiting && item.longVoice) {
      if (!batch.ackSent) {
        batch.ackSent = true;
        this.cb.onVoiceAck(batch.threadId, batch.batchId, VOICE_ACK_TEXT);
      }
    } else if (item.waiting) {
      const b = batch;
      item.capTimer = this.timers.setTimeout(() => this.onCap(b, item), this.capMs);
    }

    batch.quiet = false;
    if (batch.debounceTimer !== null) this.timers.clearTimeout(batch.debounceTimer);
    const b = batch;
    batch.debounceTimer = this.timers.setTimeout(() => {
      b.debounceTimer = null;
      b.quiet = true;
      this.tryFlush(b);
    }, this.debounceMs);
    return 'batched';
  }

  /** Transcriber result (or `null` after retry-once failed, L3.7). */
  setTranscript(messageId: string, transcript: string | null): TranscriptResult {
    const threadId = this.itemThread.get(messageId);
    const batch = threadId === undefined ? undefined : this.open.get(threadId);
    const item = batch?.items.find((i) => i.msg.messageId === messageId);
    if (batch && item) {
      if (item.capTimer !== null) this.timers.clearTimeout(item.capTimer);
      item.capTimer = null;
      item.transcript = transcript;
      item.waiting = false;
      item.capped = false;
      this.tryFlush(batch);
      return 'applied';
    }
    const f = this.followUps.get(messageId);
    if (f) {
      this.followUps.delete(messageId);
      this.cb.onTranscriptFollowUp(
        f.threadId,
        buildTranscriptEvent(f.batchId, messageId, transcript),
      );
      return 'followup';
    }
    return 'unknown';
  }

  /**
   * Restart recovery (L3.3): re-feed messages still `relay_state='pending'` after a crash.
   * Fed in timestamp order; duplicates are dropped, so nothing is lost or doubled. Voice
   * notes without a final transcript wait again; the worker must re-request transcription.
   */
  restore(pending: readonly RelayInboundMessage[]): AddResult[] {
    return [...pending]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((m) => this.add(m));
  }

  /** Thread ids with an open (not yet flushed) batch. */
  openThreads(): string[] {
    return [...this.open.keys()];
  }

  /** Cancel all timers (shutdown). Open batches stay pending in the DB for `restore`. */
  dispose(): void {
    for (const b of this.open.values()) {
      this.clearBatchTimers(b);
      for (const i of b.items) this.seen.delete(i.msg.messageId);
    }
    this.open.clear();
    this.itemThread.clear();
  }

  private onCap(batch: OpenBatch, item: Item): void {
    item.capTimer = null;
    if (!item.waiting) return;
    item.waiting = false;
    item.capped = true;
    item.transcript = null;
    this.tryFlush(batch);
  }

  private tryFlush(batch: OpenBatch): void {
    if (!batch.quiet || this.open.get(batch.threadId) !== batch) return;
    if (batch.items.some((i) => i.waiting)) return;
    this.clearBatchTimers(batch);
    this.open.delete(batch.threadId);
    const ordered = [...batch.items].sort(
      (a, b) => Date.parse(a.msg.timestamp) - Date.parse(b.msg.timestamp),
    );
    for (const i of ordered) {
      this.itemThread.delete(i.msg.messageId);
      if (i.capped) {
        this.followUps.set(i.msg.messageId, { threadId: batch.threadId, batchId: batch.batchId });
      }
    }
    this.cb.onFlush({
      threadId: batch.threadId,
      batchId: batch.batchId,
      messageIds: ordered.map((i) => i.msg.messageId),
      messages: ordered.map((i) => toRelayMessage(i.msg, i.transcript)),
    });
  }

  private scheduleKeepAlive(batch: OpenBatch): void {
    batch.keepAliveTimer = this.timers.setTimeout(() => {
      if (this.open.get(batch.threadId) !== batch) return;
      this.cb.onKeepAlive(batch.threadId);
      this.scheduleKeepAlive(batch);
    }, this.keepAliveMs);
  }

  private clearBatchTimers(batch: OpenBatch): void {
    if (batch.debounceTimer !== null) this.timers.clearTimeout(batch.debounceTimer);
    if (batch.keepAliveTimer !== null) this.timers.clearTimeout(batch.keepAliveTimer);
    for (const i of batch.items) if (i.capTimer !== null) this.timers.clearTimeout(i.capTimer);
    batch.debounceTimer = null;
    batch.keepAliveTimer = null;
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift()!);
  }
}
