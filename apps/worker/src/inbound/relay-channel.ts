/**
 * Agent relay (Lia channel) for one relay account (ARCH §4.7, ADR-6). Owns the per-thread
 * `Debouncer`, presence, voice transcription and restart recovery. Writes one `relay_batches` row
 * per flushed batch via `worker_create_relay_batch` (the DB trigger + Vercel deliverer POST it).
 *
 * The Gateway's own Hebrew replies (voice ack, unsupported type, transcription failure) are
 * enqueued through the Outbox, i.e. through the queue and the send gate (`relay.system_reply`).
 */
import type { InboundType, Presence, RelayTranscriptEvent } from '@htz/core';
import { toAllowlistE164 } from '@htz/policy';
import {
  Debouncer,
  routeInboundType,
  type DebouncerTimers,
  type FlushedBatch,
  type RelayInboundMessage,
} from '@htz/relay';
import type { Logger } from 'pino';
import type { PendingRelayMessageRow, WorkerDb } from '../db/types';
import type { Outbox } from '../queue/outbox';
import { transcribeWithRetry, type Transcriber } from '../transcribe/transcriber';
import type { MediaStore } from './media';

/** Plain-language note to Tzvi when a voice note could not be transcribed (L3.7). */
export const TRANSCRIPT_FAILED_TEXT =
  'לא הצלחתי לתמלל את ההקלטה. ההקלטה נשמרה והועברה לליה בלי תמליל.';

export interface RelaySessionOps {
  markRead(chat: string, ids: readonly string[]): Promise<void>;
  presence(chat: string, p: Presence): Promise<void>;
}

export interface AcceptedRelayMessage {
  /** messages.id (uuid): what relay_batches.message_ids holds. */
  messageId: string;
  providerMessageId: string;
  conversationId: string;
  chatJid: string;
  /** Allowlisted sender, E.164. */
  fromE164: string;
  timestamp: string;
  type: InboundType;
  text: string | null;
  replyToId: string | null;
  isForwarded: boolean;
  voiceSeconds: number | null;
  /** Voice audio when already in memory (live path); else fetched from Storage. */
  audio: { bytes: Uint8Array; mime: string } | null;
  mediaPath: string | null;
  mediaMime: string | null;
  /** Present when the transcript is already final (recovery). */
  transcript?: string | null;
}

export interface RelayChannelDeps {
  accountId: string;
  relayTargetId: string;
  debounceMs: number;
  db: Pick<
    WorkerDb,
    | 'createRelayBatch'
    | 'setTranscript'
    | 'listPendingRelayMessages'
    | 'getConversation'
    | 'relayTranscriptFollowup'
  >;
  /** The live session ops, null while disconnected. */
  session: () => RelaySessionOps | null;
  outbox: Outbox;
  transcriber: Transcriber;
  media: MediaStore;
  log: Logger;
  timers?: DebouncerTimers;
  keepAliveMs?: number;
  transcribeRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each batch insert attempt (tests/metrics). */
  onBatch?: (batch: FlushedBatch, ok: boolean) => void;
}

const VOICE_TYPES: ReadonlySet<string> = new Set(['voice']);

export class RelayChannel {
  readonly #d: RelayChannelDeps;
  readonly #debouncer: Debouncer;
  readonly #threads = new Map<string, { conversationId: string }>();
  #transcribeChain: Promise<unknown> = Promise.resolve();
  #pending = new Set<Promise<unknown>>();

  constructor(deps: RelayChannelDeps) {
    this.#d = deps;
    this.#debouncer = new Debouncer(
      {
        onFirstMessage: () => undefined, // read + composing already sent in accept()
        onKeepAlive: (thread) => this.#presence(thread, 'composing'),
        onFlush: (b) => this.#track(this.#flush(b)),
        onVoiceAck: (thread, batchId, text) =>
          this.#track(
            this.#d.outbox.systemReply(this.#d.accountId, thread, text, `voice-ack:${batchId}`),
          ),
        onUnsupported: (thread, messageId, text) =>
          this.#track(
            this.#d.outbox.systemReply(this.#d.accountId, thread, text, `unsupported:${messageId}`),
          ),
        onTranscriptFollowUp: (thread, ev) => this.#followUp(thread, ev),
      },
      {
        debounceMs: deps.debounceMs,
        ...(deps.keepAliveMs !== undefined ? { keepAliveMs: deps.keepAliveMs } : {}),
        ...(deps.timers ? { timers: deps.timers } : {}),
      },
    );
  }

  /** Live path: an allowlisted, already-ingested message (relay_state='pending'). */
  accept(m: AcceptedRelayMessage): void {
    this.#threads.set(m.chatJid, { conversationId: m.conversationId });
    const s = this.#d.session();
    if (s) {
      // L3.1: read + "typing" right away.
      if (m.providerMessageId)
        void s.markRead(m.chatJid, [m.providerMessageId]).catch(() => undefined);
      if ('relay' in routeInboundType(m.type))
        void s.presence(m.chatJid, 'composing').catch(() => undefined);
    }
    const r = this.#debouncer.add(this.#toRelayInbound(m));
    if (r === 'batched' && VOICE_TYPES.has(m.type) && m.transcript === undefined) {
      this.#track(this.#transcribe(m));
    }
  }

  /**
   * Restart recovery (L3.3): re-feed `relay_state='pending'` messages. The Debouncer drops
   * duplicates; voice notes without a stored transcript are transcribed again from Storage.
   */
  async recover(): Promise<number> {
    const rows = await this.#d.db.listPendingRelayMessages(this.#d.accountId);
    if (rows.length === 0) return 0;
    const convs = new Map<string, string | null>();
    const msgs: AcceptedRelayMessage[] = [];
    for (const row of rows) {
      if (!row.conversation_id) continue;
      if (!convs.has(row.conversation_id)) {
        const c = await this.#d.db.getConversation(row.conversation_id);
        convs.set(row.conversation_id, c?.chat_jid ?? null);
      }
      const chat = convs.get(row.conversation_id);
      const from = row.sender_jid ? toAllowlistE164(row.sender_jid) : null;
      if (!chat || !from) continue;
      msgs.push(recoveredMessage(row, chat, from));
    }
    msgs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const m of msgs) this.accept(m);
    this.#d.log.info({ n: msgs.length }, 'relay_recovered_pending');
    return msgs.length;
  }

  /** Thread ids with an open batch. */
  openThreads(): string[] {
    return this.#debouncer.openThreads();
  }

  /** Wait for in-flight batch inserts / transcriptions (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  dispose(): void {
    this.#debouncer.dispose();
  }

  // ------------------------------------------------------------------ internals

  #track<T>(p: Promise<T>): void {
    const q = p.catch((err) =>
      this.#d.log.error({ err: (err as Error).name }, 'relay_task_failed'),
    );
    this.#pending.add(q);
    void q.finally(() => this.#pending.delete(q));
  }

  #presence(thread: string, p: Presence): void {
    const s = this.#d.session();
    if (s) void s.presence(thread, p).catch(() => undefined);
  }

  #toRelayInbound(m: AcceptedRelayMessage): RelayInboundMessage {
    const r: RelayInboundMessage = {
      messageId: m.messageId,
      threadId: m.chatJid,
      from: m.fromE164,
      timestamp: m.timestamp,
      type: m.type,
      text: m.text,
      // Signed URLs are minted by the server-side deliverer from messages.media_path.
      mediaUrl: null,
      replyToId: m.replyToId,
      isForwarded: m.isForwarded,
      voiceSeconds: m.voiceSeconds,
    };
    if (m.transcript !== undefined) r.transcript = m.transcript;
    return r;
  }

  async #transcribe(m: AcceptedRelayMessage): Promise<void> {
    // Concurrency 1 (the local service is single-job); keeps send order (L3.6).
    const run = this.#transcribeChain.then(async () => {
      let audio = m.audio;
      if (!audio && m.mediaPath) {
        try {
          audio = {
            bytes: await this.#d.media.download(m.mediaPath),
            mime: m.mediaMime ?? 'audio/ogg',
          };
        } catch {
          audio = null;
        }
      }
      const t = audio
        ? await transcribeWithRetry(this.#d.transcriber, audio.bytes, audio.mime, {
            ...(this.#d.transcribeRetryDelayMs !== undefined
              ? { retryDelayMs: this.#d.transcribeRetryDelayMs }
              : {}),
            ...(this.#d.sleep ? { sleep: this.#d.sleep } : {}),
            onError: (err, attempt) =>
              this.#d.log.warn(
                { attempt, reason: (err as Error).message?.slice(0, 80) },
                'transcribe_failed',
              ),
          })
        : null;
      if (t) {
        await this.#d.db.setTranscript(m.messageId, t.text).catch(() => undefined);
        this.#d.log.info(
          { backend: t.backend, duration_s: t.durationS, elapsed_ms: t.elapsedMs },
          'transcribed',
        );
      } else {
        // L3.7: give up after one retry → transcript null + plain explanation to Tzvi; audio kept.
        await this.#d.outbox.systemReply(
          this.#d.accountId,
          m.chatJid,
          TRANSCRIPT_FAILED_TEXT,
          `transcript-failed:${m.messageId}`,
        );
      }
      this.#debouncer.setTranscript(m.messageId, t ? t.text : null);
    });
    this.#transcribeChain = run.catch(() => undefined);
    await run;
  }

  async #flush(b: FlushedBatch): Promise<void> {
    const conversationId = this.#threads.get(b.threadId)?.conversationId ?? null;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await this.#d.db.createRelayBatch(
          this.#d.relayTargetId,
          b.messageIds,
          conversationId,
          false,
          b.batchId,
        );
        ok = true;
      } catch (err) {
        this.#d.log.warn(
          { attempt, err: (err as Error).name, correlation_id: b.batchId },
          'relay_batch_insert_failed',
        );
        if (attempt < 3)
          await (this.#d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1_000 * attempt);
      }
    }
    // On failure the messages stay relay_state='pending' and are re-batched on the next boot (L3.3).
    if (ok)
      this.#d.log.info(
        { correlation_id: b.batchId, n: b.messageIds.length },
        'relay_batch_created',
      );
    else this.#d.log.error({ correlation_id: b.batchId }, 'relay_batch_lost_until_restart');
    this.#presence(b.threadId, 'paused');
    this.#d.onBatch?.(b, ok);
  }

  #followUp(_thread: string, ev: RelayTranscriptEvent): void {
    // L3.4: the batch already went out with transcript:null → the deliverer POSTs a follow-up
    // event with the same message_id (signed like batches), also after Lia already replied.
    this.#track(
      this.#d.db
        .relayTranscriptFollowup(ev.batch_id, ev.message_id, ev.transcript)
        .then(() =>
          this.#d.log.info(
            { correlation_id: ev.batch_id, has_transcript: ev.transcript !== null },
            'relay_transcript_followup_queued',
          ),
        ),
    );
  }
}

export function recoveredMessage(
  row: PendingRelayMessageRow,
  chatJid: string,
  fromE164: string,
): AcceptedRelayMessage {
  const m: AcceptedRelayMessage = {
    messageId: row.id,
    providerMessageId: '',
    conversationId: row.conversation_id ?? '',
    chatJid,
    fromE164,
    timestamp: row.received_at ?? row.created_at,
    type: row.kind as InboundType,
    text: row.body,
    replyToId: row.quoted_provider_id,
    isForwarded: row.is_forwarded,
    voiceSeconds: row.media_seconds === null ? null : Number(row.media_seconds),
    audio: null,
    mediaPath: row.media_path,
    mediaMime: row.media_mime,
  };
  if (row.kind === 'voice' && row.transcript_ready_at) m.transcript = row.transcript;
  return m;
}
