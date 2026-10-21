/**
 * `WorkerDb` over @supabase/supabase-js, authenticated as `gateway_worker` (custom JWT, never the
 * service-role key). Thin: one method = one RPC or one RLS-allowed select. Argument names follow
 * supabase/migrations/*rpc_messaging.sql and *rpc_worker.sql exactly.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageStatus } from '@htz/core';
import type {
  AccountRow,
  AutomationRow,
  ClaimedJob,
  ConversationRow,
  EnqueueMessageArgs,
  EnqueueMessageResult,
  IngestInboundArgs,
  IngestInboundResult,
  PairingRequestRow,
  PendingRelayMessageRow,
  RelayTargetRow,
  ReplyOutcome,
  SessionCommandRow,
  SessionEventName,
  WorkerDb,
  WorkerLogEntry,
} from './types';

export class DbError extends Error {
  constructor(
    readonly op: string,
    readonly code: string | null,
    detail: string,
  ) {
    super(`${op}: ${code ?? 'error'} ${detail}`.trim());
    this.name = 'DbError';
  }
}

interface PgErr {
  code?: string;
  message?: string;
}

function check<T>(op: string, r: { data: T | null; error: PgErr | null }): T {
  // Postgres/PostgREST messages may echo argument values; keep only the first 160 chars.
  if (r.error) throw new DbError(op, r.error.code ?? null, (r.error.message ?? '').slice(0, 160));
  return r.data as T;
}

const firstRow = <T>(rows: T[] | T | null): T | null =>
  Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);

const ACCOUNT_COLS =
  'id, org_id, provider, label, phone_e164, status, capabilities, use_case_policy, pacing';
const PENDING_COLS =
  'id, conversation_id, kind, body, sender_jid, media_path, media_mime, media_seconds, transcript, transcript_ready_at, quoted_provider_id, is_forwarded, received_at, created_at';

export function createSupabaseWorkerDb(client: SupabaseClient): WorkerDb {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> =>
    check<T>(fn, await client.rpc(fn, args));

  return {
    async listBaileysAccounts(orgId) {
      const r = await client
        .from('accounts')
        .select(ACCOUNT_COLS)
        .eq('org_id', orgId)
        .eq('provider', 'baileys')
        .order('created_at');
      return check<AccountRow[]>('accounts.select', r) ?? [];
    },
    async getAccount(accountId) {
      const r = await client.from('accounts').select(ACCOUNT_COLS).eq('id', accountId).limit(1);
      return firstRow(check<AccountRow[]>('accounts.get', r));
    },
    async listRelayTargets(accountId) {
      const r = await client
        .from('relay_targets')
        .select('id, account_id, enabled, debounce_ms, allowed_senders')
        .eq('account_id', accountId);
      return check<RelayTargetRow[]>('relay_targets.select', r) ?? [];
    },
    async getConversation(conversationId) {
      const r = await client
        .from('conversations')
        .select('id, account_id, chat_jid, type, last_inbound_at')
        .eq('id', conversationId)
        .limit(1);
      return firstRow(check<ConversationRow[]>('conversations.get', r));
    },
    async listPendingRelayMessages(accountId) {
      const r = await client
        .from('messages')
        .select(PENDING_COLS)
        .eq('account_id', accountId)
        .eq('relay_state', 'pending')
        .eq('direction', 'in')
        .order('received_at', { ascending: true })
        .limit(500);
      return check<PendingRelayMessageRow[]>('messages.pending', r) ?? [];
    },
    async listAutomations(accountId) {
      const r = await client
        .from('automations')
        .select(
          'id, account_id, name, enabled, bind_mode, status_id, keywords, match_mode, case_sensitive, ignore_emoji, reply_text, reply_media_path, options, try_native_buttons, daily_cap, max_age_sec, created_at, status:statuses(provider_status_id)',
        )
        .eq('account_id', accountId)
        .order('created_at');
      const rows = check<Array<Omit<AutomationRow, 'provider_status_id'> & { status: unknown }>>(
        'automations.select',
        r,
      );
      return (rows ?? []).map(({ status, ...a }) => {
        const s = (Array.isArray(status) ? status[0] : status) as
          { provider_status_id?: string } | null | undefined;
        return { ...a, provider_status_id: s?.provider_status_id ?? null };
      });
    },
    async listStatusReplySendTimes(accountId, sinceIso) {
      const r = await client
        .from('messages')
        .select('created_at')
        .eq('account_id', accountId)
        .eq('direction', 'out')
        .eq('use_case', 'status_automation')
        .gte('created_at', sinceIso)
        .limit(5_000);
      return (check<Array<{ created_at: string }>>('messages.status_sends', r) ?? []).map(
        (x) => x.created_at,
      );
    },
    async listPendingSessionCommands(orgId) {
      const r = await client
        .from('session_commands')
        .select('id, account_id, command, state, created_at, payload')
        .eq('org_id', orgId)
        .eq('state', 'pending')
        .order('created_at');
      return check<SessionCommandRow[]>('session_commands.select', r) ?? [];
    },
    async listPendingPairingRequests(orgId) {
      const r = await client
        .from('pairing_requests')
        .select('id, account_id, method, phone_e164, state, expires_at')
        .eq('org_id', orgId)
        .in('state', ['pending', 'active'])
        .gt('expires_at', new Date().toISOString())
        .order('created_at');
      return check<PairingRequestRow[]>('pairing_requests.select', r) ?? [];
    },

    // ---- queue
    async claimJobs(workerId, n) {
      return (
        (await rpc<ClaimedJob[]>('claim_jobs', {
          p_worker_id: workerId,
          p_executor: 'worker',
          p_n: n,
        })) ?? []
      );
    },
    renewLease: (jobId, workerId) =>
      rpc<string | null>('renew_lease', { p_job_id: jobId, p_worker_id: workerId }),
    reserveProviderId: (jobId, workerId, id) =>
      rpc<boolean>('job_reserve_provider_id', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_provider_message_id: id,
      }),
    completeJob: (jobId, providerMessageId, deliveryMode = null) =>
      rpc<boolean>('complete_job', {
        p_job_id: jobId,
        p_provider_message_id: providerMessageId,
        p_delivery_mode: deliveryMode,
      }),
    failJob: (jobId, code, transient, detail = null) =>
      rpc<string>('fail_job', {
        p_job_id: jobId,
        p_error_code: code,
        p_transient: transient,
        p_detail: detail,
      }),
    async enqueueMessage(args: EnqueueMessageArgs) {
      const rows = await rpc<EnqueueMessageResult[]>('enqueue_message', { ...args });
      const row = firstRow(rows);
      if (!row) throw new DbError('enqueue_message', null, 'no row returned');
      return row;
    },
    async ingestInbound(args: IngestInboundArgs) {
      const rows = await rpc<IngestInboundResult[]>('ingest_inbound', { ...args });
      const row = firstRow(rows);
      if (!row) throw new DbError('ingest_inbound', null, 'no row returned');
      return row;
    },
    applyMessageStatus: (accountId, providerMessageId, status: MessageStatus, at = null) =>
      rpc<boolean>('apply_message_status', {
        p_account_id: accountId,
        p_provider_message_id: providerMessageId,
        p_status: status,
        p_at: at,
      }),
    async setTranscript(messageId, transcript) {
      return Boolean(
        await rpc<boolean | null>('message_set_transcript', {
          p_message_id: messageId,
          p_transcript: transcript,
        }),
      );
    },

    // ---- worker
    async recordHeartbeat(orgId, workerId, version, baileysVersion, sockets) {
      await rpc<null>('record_heartbeat', {
        p_org_id: orgId,
        p_worker_id: workerId,
        p_version: version,
        p_baileys_version: baileysVersion,
        p_sockets: sockets,
      });
    },
    tryLockAccount: (accountId, workerId, ttl) =>
      rpc<boolean>('worker_try_lock_account', {
        p_account_id: accountId,
        p_worker_id: workerId,
        p_ttl_seconds: ttl,
      }),
    async unlockAccount(accountId, workerId) {
      return Boolean(
        await rpc<boolean | null>('worker_unlock_account', {
          p_account_id: accountId,
          p_worker_id: workerId,
        }),
      );
    },
    sessionEvent: (accountId, workerId, event: SessionEventName, code = null) =>
      rpc<string>('worker_session_event', {
        p_account_id: accountId,
        p_worker_id: workerId,
        p_event: event,
        p_code: code,
      }),
    completeSessionCommand: (id, state, result = null) =>
      rpc<boolean>('worker_complete_session_command', {
        p_command_id: id,
        p_state: state,
        p_result: result,
      }),
    pairingQrUpsert: (requestId, workerId, secret) =>
      rpc<string>('worker_pairing_qr_upsert', {
        p_request_id: requestId,
        p_worker_id: workerId,
        p_qr: 'qr' in secret ? secret.qr : null,
        p_pairing_code: 'pairingCode' in secret ? secret.pairingCode : null,
        p_ttl_seconds: 60,
      }),
    pairingFinish: (requestId, workerId, state, phone = null) =>
      rpc<boolean>('worker_pairing_finish', {
        p_request_id: requestId,
        p_worker_id: workerId,
        p_state: state,
        p_phone_e164: phone,
      }),
    upsertContact: (accountId, pn, lid, name) =>
      rpc<string>('worker_upsert_contact', {
        p_account_id: accountId,
        p_pn_jid: pn,
        p_lid: lid,
        p_display_name: name,
      }),
    upsertStatus: (accountId, providerStatusId, kind, caption, mediaPath, postedAt) =>
      rpc<string>('worker_upsert_status', {
        p_account_id: accountId,
        p_provider_status_id: providerStatusId,
        p_kind: kind,
        p_caption: caption,
        p_media_path: mediaPath,
        p_posted_at: postedAt,
      }),
    takeCooldown: (accountId, providerStatusId, contactKey, automationId, statusId) =>
      rpc<boolean>('worker_take_cooldown', {
        p_account_id: accountId,
        p_provider_status_id: providerStatusId,
        p_contact_key: contactKey,
        p_automation_id: automationId,
        p_status_id: statusId,
      }),
    recordReplyJob: (accountId, outcome: ReplyOutcome, f) =>
      rpc<string>('worker_record_reply_job', {
        p_account_id: accountId,
        p_outcome: outcome,
        p_automation_id: f.automationId ?? null,
        p_status_id: f.statusId ?? null,
        p_inbound_message_id: f.inboundMessageId ?? null,
        p_outbound_message_id: f.outboundMessageId ?? null,
        p_contact_key: f.contactKey ?? null,
        p_detail: f.detail ?? null,
      }),
    createRelayBatch: (relayTargetId, messageIds, conversationId, isTest, batchId) =>
      rpc<string>('worker_create_relay_batch', {
        p_relay_target_id: relayTargetId,
        p_message_ids: messageIds,
        p_conversation_id: conversationId,
        p_is_test: isTest,
        p_batch_id: batchId,
      }),
    relayDeliveryFailed: async (messageId) =>
      Boolean(
        await rpc<boolean | null>('worker_relay_delivery_failed', { p_message_id: messageId }),
      ),
    relayTranscriptFollowup: (batchId, messageId, transcript) =>
      rpc<string>('worker_relay_transcript_followup', {
        p_batch_id: batchId,
        p_message_id: messageId,
        p_transcript: transcript,
      }),
    workerLog: (orgId, workerId, entries: WorkerLogEntry[]) =>
      rpc<number>('worker_log', { p_org_id: orgId, p_worker_id: workerId, p_entries: entries }),
    auditAppend: (orgId, workerId, action, target, meta) =>
      rpc<string>('audit_append', {
        p_org_id: orgId,
        p_actor_type: 'worker',
        p_actor_id: workerId,
        p_action: action,
        p_target: target,
        p_ip: null,
        p_meta: meta,
      }),
  };
}
