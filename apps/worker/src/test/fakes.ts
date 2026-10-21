/**
 * Test doubles for worker unit tests (no network, no sockets). Numbers are fictitious:
 * +972559014410 (allowlisted "Tzvi") and +972500000001 (unknown sender).
 */
import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import type { ConnectionState, InboundEvent, Presence, SessionHealth } from '@htz/core';
import type { SessionEvent, SessionEventListener, SelfIdentity } from '@htz/provider-baileys';
import type {
  AccountRow,
  AutomationRow,
  ClaimedJob,
  ConversationRow,
  EnqueueMessageArgs,
  IngestInboundArgs,
  PairingRequestRow,
  PendingRelayMessageRow,
  RelayTargetRow,
  SessionCommandRow,
  WorkerDb,
} from '../db/types';
import type { ManagedSession } from '../session/manager';

export const TZVI_E164 = '+972559014410';
export const TZVI_PN = '972559014410@s.whatsapp.net';
export const TZVI_LID = '123456789012345@lid';
export const STRANGER_PN = '972500000001@s.whatsapp.net';
export const ORG = '00000000-0000-4000-8000-000000000001';
export const ACC = '00000000-0000-4000-8000-0000000000a1';
export const TARGET = '00000000-0000-4000-8000-0000000000b1';

/** Logger that captures every line (to assert secrets never appear). */
export function captureLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { log: pino({ level: 'trace', messageKey: 'event' }, sink), lines };
}

export const silentLogger = (): Logger => pino({ level: 'silent' });

export function relayAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: ACC,
    org_id: ORG,
    provider: 'baileys',
    label: 'lia',
    phone_e164: null,
    status: 'open',
    capabilities: {},
    use_case_policy: { allowed_use_cases: ['agent_relay'], may_initiate: false, relay: true },
    pacing: {},
    ...overrides,
  };
}

export function relayTarget(overrides: Partial<RelayTargetRow> = {}): RelayTargetRow {
  return {
    id: TARGET,
    account_id: ACC,
    enabled: true,
    debounce_ms: 4000,
    allowed_senders: [],
    ...overrides,
  };
}

let seq = 0;
export const uuid = (): string =>
  `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

type Call = { fn: string; args: unknown[] };

/** In-memory WorkerDb recording every call. Behaviour is overridable per test. */
export class FakeDb implements WorkerDb {
  calls: Call[] = [];
  accounts = new Map<string, AccountRow>();
  targets: RelayTargetRow[] = [];
  conversations = new Map<string, ConversationRow>();
  messages = new Map<string, { args: IngestInboundArgs; id: string; conversation_id: string }>();
  pending: PendingRelayMessageRow[] = [];
  automations: AutomationRow[] = [];
  jobs: ClaimedJob[] = [];
  commands: SessionCommandRow[] = [];
  pairing: PairingRequestRow[] = [];
  enqueued: Array<EnqueueMessageArgs & { message_id: string }> = [];
  cooldowns = new Set<string>();
  lockResult: boolean | (() => boolean) = true;
  renewResult: string | null = new Date(Date.now() + 60_000).toISOString();

  #rec(fn: string, ...args: unknown[]) {
    this.calls.push({ fn, args });
  }
  callsOf(fn: string): unknown[][] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }

  async listBaileysAccounts() {
    return [...this.accounts.values()];
  }
  async getAccount(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async listRelayTargets(accountId: string) {
    return this.targets.filter((t) => t.account_id === accountId);
  }
  async getConversation(id: string) {
    return this.conversations.get(id) ?? null;
  }
  async listPendingRelayMessages() {
    return this.pending;
  }
  async listAutomations() {
    return this.automations;
  }
  async listStatusReplySendTimes() {
    return [];
  }
  async listPendingSessionCommands() {
    return this.commands.filter((c) => c.state === 'pending');
  }
  async listPendingPairingRequests() {
    return this.pairing;
  }
  async claimJobs(workerId: string, n: number) {
    this.#rec('claimJobs', workerId, n);
    return this.jobs.splice(0, n);
  }
  async renewLease(jobId: string, workerId: string) {
    this.#rec('renewLease', jobId, workerId);
    return this.renewResult;
  }
  async reserveProviderId(...a: unknown[]) {
    this.#rec('reserveProviderId', ...a);
    return true;
  }
  async completeJob(...a: unknown[]) {
    this.#rec('completeJob', ...a);
    return true;
  }
  async failJob(jobId: string, code: string, transient: boolean, detail?: string | null) {
    this.#rec('failJob', jobId, code, transient, detail);
    return transient ? 'ready' : 'dead';
  }
  async enqueueMessage(args: EnqueueMessageArgs) {
    this.#rec('enqueueMessage', args);
    const message_id = uuid();
    this.enqueued.push({ ...args, message_id });
    return {
      message_id,
      status: 'queued',
      created: true,
      job_id: uuid(),
      conversation_id: null,
      provider_message_id: null,
    };
  }
  async ingestInbound(args: IngestInboundArgs) {
    this.#rec('ingestInbound', args);
    const key = `${args.p_account_id}:${args.p_provider_message_id}`;
    const hit = this.messages.get(key);
    if (hit) return { message_id: hit.id, conversation_id: hit.conversation_id, created: false };
    let conv = [...this.conversations.values()].find((c) => c.chat_jid === args.p_chat_jid);
    if (!conv) {
      conv = {
        id: uuid(),
        account_id: args.p_account_id,
        chat_jid: args.p_chat_jid,
        type: 'direct',
        last_inbound_at: args.p_from_me ? null : (args.p_received_at ?? new Date().toISOString()),
      };
      this.conversations.set(conv.id, conv);
    }
    const id = uuid();
    this.messages.set(key, { args, id, conversation_id: conv.id });
    return { message_id: id, conversation_id: conv.id, created: true };
  }
  async applyMessageStatus(...a: unknown[]) {
    this.#rec('applyMessageStatus', ...a);
    return true;
  }
  async setTranscript(...a: unknown[]) {
    this.#rec('setTranscript', ...a);
    return true;
  }
  async recordHeartbeat(...a: unknown[]) {
    this.#rec('recordHeartbeat', ...a);
  }
  async tryLockAccount(...a: unknown[]) {
    this.#rec('tryLockAccount', ...a);
    return typeof this.lockResult === 'function' ? this.lockResult() : this.lockResult;
  }
  async unlockAccount(...a: unknown[]) {
    this.#rec('unlockAccount', ...a);
    return true;
  }
  async sessionEvent(...a: unknown[]) {
    this.#rec('sessionEvent', ...a);
    return uuid();
  }
  async completeSessionCommand(...a: unknown[]) {
    this.#rec('completeSessionCommand', ...a);
    return true;
  }
  async pairingQrUpsert(...a: unknown[]) {
    this.#rec('pairingQrUpsert', ...a);
    return uuid();
  }
  async pairingFinish(...a: unknown[]) {
    this.#rec('pairingFinish', ...a);
    return true;
  }
  async upsertContact(...a: unknown[]) {
    this.#rec('upsertContact', ...a);
    return uuid();
  }
  async upsertStatus(...a: unknown[]) {
    this.#rec('upsertStatus', ...a);
    return uuid();
  }
  async takeCooldown(accountId: string, statusId: string, key: string) {
    this.#rec('takeCooldown', accountId, statusId, key);
    const k = `${accountId}|${statusId}|${key}`;
    if (this.cooldowns.has(k)) return false;
    this.cooldowns.add(k);
    return true;
  }
  async recordReplyJob(...a: unknown[]) {
    this.#rec('recordReplyJob', ...a);
    return uuid();
  }
  async createRelayBatch(...a: unknown[]) {
    this.#rec('createRelayBatch', ...a);
    return String(a[4]);
  }
  async relayDeliveryFailed(...a: unknown[]) {
    this.#rec('relayDeliveryFailed', ...a);
    return true;
  }
  async relayTranscriptFollowup(...a: unknown[]) {
    this.#rec('relayTranscriptFollowup', ...a);
    return uuid();
  }
  async workerLog(...a: unknown[]) {
    this.#rec('workerLog', ...a);
    return 1;
  }
  async auditAppend(...a: unknown[]) {
    this.#rec('auditAppend', ...a);
    return uuid();
  }
}

/** Fake BaileysSession: emits events on demand, records calls. */
export class FakeSession implements ManagedSession {
  state: ConnectionState = 'closed';
  me: SelfIdentity | null = null;
  registered = true;
  calls: Call[] = [];
  lidMap = new Map<string, string>();
  readonly #listeners = new Set<SessionEventListener>();

  constructor(readonly accountId: string) {}

  on(l: SessionEventListener) {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
  emit(body: Record<string, unknown> & { type: string }) {
    const e = {
      ...body,
      accountId: this.accountId,
      at: new Date().toISOString(),
    } as unknown as SessionEvent;
    for (const l of this.#listeners) l(e);
  }
  get listenerCount() {
    return this.#listeners.size;
  }
  async start() {
    this.calls.push({ fn: 'start', args: [] });
  }
  async close() {
    this.calls.push({ fn: 'close', args: [] });
    this.state = 'closed';
  }
  async logout() {
    this.calls.push({ fn: 'logout', args: [] });
    this.state = 'needs_relink';
  }
  health(): SessionHealth {
    return {
      accountId: this.accountId,
      provider: 'baileys',
      connection: this.state,
      connectedAt: null,
      lastHeartbeatAt: null,
      lastErrorCode: null,
    };
  }
  async sendMessage(jid: string) {
    this.calls.push({ fn: 'sendMessage', args: [jid] });
    return { id: `SENT${this.calls.length}` };
  }
  async react() {
    return { id: 'R1' };
  }
  async markRead(chat: string, ids: readonly string[]) {
    this.calls.push({ fn: 'markRead', args: [chat, ids] });
  }
  async presence(chat: string, p: Presence) {
    this.calls.push({ fn: 'presence', args: [chat, p] });
  }
  async pnForLid(lid: string) {
    return this.lidMap.get(lid) ?? null;
  }
  async lidForPn(pn: string) {
    for (const [l, p] of this.lidMap) if (p === pn) return l;
    return null;
  }
  async downloadMedia() {
    return Buffer.from('OggS-fake-audio');
  }
  callsOf(fn: string) {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
}

export function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    accountId: ACC,
    provider: 'baileys',
    providerMessageId: `WAID${++seq}`,
    chat: TZVI_PN,
    senderPn: TZVI_PN,
    senderLid: null,
    isGroup: false,
    fromMe: false,
    type: 'text',
    text: 'שלום',
    pushName: 'T',
    timestamp: new Date().toISOString(),
    isForwarded: false,
    quotedProviderId: null,
    media: null,
    statusReplyToId: null,
    ...overrides,
  };
}

export const flush = () => new Promise((r) => setImmediate(r));
