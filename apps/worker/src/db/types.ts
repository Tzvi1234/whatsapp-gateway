/**
 * Typed surface of everything the worker reads/writes in Supabase as role `gateway_worker`
 * (docs/database.md §3/§4). Method args mirror the RPC parameters 1:1; the Supabase
 * implementation lives in `supabase-db.ts`, tests use `test/fake-db.ts`.
 */
import type { MessageStatus } from '@htz/core';

export type ProviderKind = 'baileys' | 'meta_cloud';

export interface AccountRow {
  id: string;
  org_id: string;
  provider: ProviderKind;
  label: string;
  phone_e164: string | null;
  status: string;
  capabilities: Record<string, unknown>;
  use_case_policy: Record<string, unknown>;
  pacing: Record<string, unknown>;
}

export interface RelayTargetRow {
  id: string;
  account_id: string;
  enabled: boolean;
  debounce_ms: number;
  allowed_senders: string[];
}

export interface ConversationRow {
  id: string;
  account_id: string;
  chat_jid: string;
  type: 'direct' | 'group' | 'status';
  last_inbound_at: string | null;
}

export interface ClaimedJob {
  job_id: string;
  message_id: string;
  account_id: string;
  conversation_id: string | null;
  chat_jid: string | null;
  attempts: number;
  lease_until: string;
  kind: string;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  template: unknown;
  quoted_provider_id: string | null;
  provider_message_id: string | null;
  idempotency_key: string | null;
  use_case: string | null;
  delivery_mode: string | null;
}

export interface SessionCommandRow {
  id: string;
  account_id: string;
  command: 'reconnect' | 'logout' | 'pair' | 'mark_read';
  state: string;
  /** mark_read: {"chat": "<jid>", "ids": ["<provider message id>", ...]}; else null. */
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface PairingRequestRow {
  id: string;
  account_id: string;
  method: 'qr' | 'pairing_code';
  phone_e164: string | null;
  state: string;
  expires_at: string;
}

export interface PendingRelayMessageRow {
  id: string;
  conversation_id: string | null;
  kind: string;
  body: string | null;
  sender_jid: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_seconds: number | null;
  transcript: string | null;
  transcript_ready_at: string | null;
  quoted_provider_id: string | null;
  is_forwarded: boolean;
  received_at: string | null;
  created_at: string;
}

export interface AutomationRow {
  id: string;
  account_id: string;
  name: string;
  enabled: boolean;
  bind_mode: 'status' | 'next_status';
  status_id: string | null;
  keywords: string[];
  match_mode: 'exact' | 'contains';
  case_sensitive: boolean;
  ignore_emoji: boolean;
  reply_text: string | null;
  reply_media_path: string | null;
  options: string[];
  try_native_buttons: boolean;
  daily_cap: number | null;
  max_age_sec: number;
  created_at: string;
  /** statuses.provider_status_id of `status_id` (joined). */
  provider_status_id: string | null;
}

export interface EnqueueMessageArgs {
  p_account_id: string;
  p_chat_jid: string;
  p_kind: 'text' | 'media' | 'reaction';
  p_body?: string | null;
  p_media_path?: string | null;
  p_media_mime?: string | null;
  p_quoted_provider_id?: string | null;
  p_use_case?: string | null;
  p_idempotency_key?: string | null;
  p_executor?: 'auto' | 'worker';
  p_delivery_mode?: 'native' | 'fallback' | 'text' | null;
}

export interface EnqueueMessageResult {
  message_id: string;
  status: string;
  created: boolean;
  job_id: string | null;
  conversation_id: string | null;
  provider_message_id: string | null;
}

export interface IngestInboundArgs {
  p_account_id: string;
  p_provider_message_id: string;
  p_chat_jid: string;
  p_kind: string;
  p_body?: string | null;
  p_sender_jid?: string | null;
  p_from_me?: boolean;
  p_push_name?: string | null;
  p_received_at?: string | null;
  p_is_forwarded?: boolean;
  p_quoted_provider_id?: string | null;
  p_media_path?: string | null;
  p_media_mime?: string | null;
  p_media_seconds?: number | null;
  p_relay_state?: 'pending' | 'batched' | 'skipped' | null;
  p_raw?: unknown;
  p_source?: 'baileys';
  p_chat_type?: 'direct' | 'group' | 'status' | null;
}

export interface IngestInboundResult {
  message_id: string;
  conversation_id: string;
  created: boolean;
}

export type SessionEventName =
  | 'connecting'
  | 'open'
  | 'close'
  | 'qr'
  | 'paired'
  | 'relinked'
  | 'conflict'
  | 'needs_relink'
  | 'logged_out'
  | 'restored';

export interface WorkerLogEntry {
  level: string;
  msg: string;
  correlation_id?: string | null;
  data?: unknown;
  at: string;
}

export type ReplyOutcome =
  | 'queued'
  | 'sent'
  | 'failed'
  | 'skipped_disabled'
  | 'skipped_not_direct'
  | 'skipped_cooldown'
  | 'skipped_stale'
  | 'skipped_cap'
  | 'skipped_no_match';

/** Every DB operation the worker performs. RPC names in comments. */
export interface WorkerDb {
  // ---- reads (RLS select grants for gateway_worker)
  listBaileysAccounts(orgId: string): Promise<AccountRow[]>;
  getAccount(accountId: string): Promise<AccountRow | null>;
  listRelayTargets(accountId: string): Promise<RelayTargetRow[]>;
  getConversation(conversationId: string): Promise<ConversationRow | null>;
  listPendingRelayMessages(accountId: string): Promise<PendingRelayMessageRow[]>;
  listAutomations(accountId: string): Promise<AutomationRow[]>;
  /** created_at of status-automation sends on this account since `sinceIso` (daily cap). */
  listStatusReplySendTimes(accountId: string, sinceIso: string): Promise<string[]>;
  listPendingSessionCommands(orgId: string): Promise<SessionCommandRow[]>;
  listPendingPairingRequests(orgId: string): Promise<PairingRequestRow[]>;

  // ---- queue (rpc_messaging)
  claimJobs(workerId: string, n: number): Promise<ClaimedJob[]>; // claim_jobs(p_worker_id,'worker',p_n)
  renewLease(jobId: string, workerId: string): Promise<string | null>; // renew_lease
  reserveProviderId(jobId: string, workerId: string, providerMessageId: string): Promise<boolean>; // job_reserve_provider_id
  completeJob(
    jobId: string,
    providerMessageId: string,
    deliveryMode?: string | null,
  ): Promise<boolean>; // complete_job
  failJob(
    jobId: string,
    errorCode: string,
    transient: boolean,
    detail?: string | null,
  ): Promise<string>; // fail_job
  enqueueMessage(args: EnqueueMessageArgs): Promise<EnqueueMessageResult>; // enqueue_message
  ingestInbound(args: IngestInboundArgs): Promise<IngestInboundResult>; // ingest_inbound
  applyMessageStatus(
    accountId: string,
    providerMessageId: string,
    status: MessageStatus,
    at?: string | null,
  ): Promise<boolean>; // apply_message_status
  setTranscript(messageId: string, transcript: string): Promise<boolean>; // message_set_transcript

  // ---- worker (rpc_worker)
  recordHeartbeat(
    orgId: string,
    workerId: string,
    version: string | null,
    baileysVersion: string | null,
    sockets: unknown[],
  ): Promise<void>; // record_heartbeat
  tryLockAccount(accountId: string, workerId: string, ttlSeconds: number): Promise<boolean>; // worker_try_lock_account
  unlockAccount(accountId: string, workerId: string): Promise<boolean>; // worker_unlock_account
  sessionEvent(
    accountId: string,
    workerId: string,
    event: SessionEventName,
    code?: string | null,
  ): Promise<string>; // worker_session_event
  completeSessionCommand(
    commandId: string,
    state: 'done' | 'failed',
    result?: string | null,
  ): Promise<boolean>; // worker_complete_session_command
  pairingQrUpsert(
    requestId: string,
    workerId: string,
    secret: { qr: string } | { pairingCode: string },
  ): Promise<string>; // worker_pairing_qr_upsert
  pairingFinish(
    requestId: string,
    workerId: string,
    state: 'paired' | 'expired' | 'failed',
    phoneE164?: string | null,
  ): Promise<boolean>; // worker_pairing_finish
  upsertContact(
    accountId: string,
    pnJid: string | null,
    lid: string | null,
    displayName: string | null,
  ): Promise<string>; // worker_upsert_contact
  upsertStatus(
    accountId: string,
    providerStatusId: string,
    kind: string | null,
    caption: string | null,
    mediaPath: string | null,
    postedAt: string | null,
  ): Promise<string>; // worker_upsert_status
  takeCooldown(
    accountId: string,
    providerStatusId: string,
    contactKey: string,
    automationId: string | null,
    statusId: string | null,
  ): Promise<boolean>; // worker_take_cooldown
  recordReplyJob(
    accountId: string,
    outcome: ReplyOutcome,
    f: {
      automationId?: string | null;
      statusId?: string | null;
      inboundMessageId?: string | null;
      outboundMessageId?: string | null;
      contactKey?: string | null;
      detail?: string | null;
    },
  ): Promise<string>; // worker_record_reply_job
  createRelayBatch(
    relayTargetId: string,
    messageIds: string[],
    conversationId: string | null,
    isTest: boolean,
    batchId: string,
  ): Promise<string>; // worker_create_relay_batch
  /** L4.6: Lia's reply (this outbound message) could not be delivered. */
  relayDeliveryFailed(messageId: string): Promise<boolean>; // worker_relay_delivery_failed
  /** L3.4: transcript finished after its batch was posted → follow-up event to the relay target. */
  relayTranscriptFollowup(
    batchId: string,
    messageId: string,
    transcript: string | null,
  ): Promise<string>; // worker_relay_transcript_followup
  workerLog(orgId: string, workerId: string, entries: WorkerLogEntry[]): Promise<number>; // worker_log
  auditAppend(
    orgId: string,
    workerId: string,
    action: string,
    target: string | null,
    meta: Record<string, unknown>,
  ): Promise<string>; // audit_append
}
