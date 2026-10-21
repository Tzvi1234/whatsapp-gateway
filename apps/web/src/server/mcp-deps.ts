import 'server-only';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  e164ToJid,
  err,
  gatewayError,
  isGatewayErrorCode,
  isScope,
  normalizeJid,
  ok,
  type ConnectionState,
  type OutboundKind,
  type Result,
  type Scope,
  type SessionHealth,
} from '@htz/core';
import type {
  AccountRef,
  ApiKeyRecord,
  Automation,
  AutomationInput,
  ChatView,
  McpDeps,
  Reminder,
  ReminderState,
  SendGateContext as McpGateContext,
  TemplateView,
} from '@htz/mcp';
import { parseUseCasePolicy, SEND_ENTRY_POINTS, type SendEntryPoint } from '@htz/policy';
import { markdownToWhatsApp } from '@htz/relay';
import {
  filterTemplates,
  GraphClient,
  listTemplates,
  type CloudApiProvider,
  type TemplateCategory,
} from '@htz/provider-cloud';
import { serviceClient, type Db } from './supabase';
import { isUuid, query, rpc, rpcRow } from './db';
import { logError } from './log';
import { createCloudProvider, readCloudCredentials } from './cloud';
import { checkSend } from './send-gate';
import { enqueueAndDispatch } from './outbound';
import {
  capabilitiesOf,
  CONVERSATION_COLUMNS,
  defaultUseCaseOf,
  getAccount,
  getAccountByAlias,
  getConversation,
  listAccountsByIds,
  type AccountRow,
  type ConversationRow,
} from './repo/accounts';
import {
  findAccountMessage,
  getMessageRow,
  MESSAGE_COLUMNS,
  toMessageView,
  type MessageRow,
} from './repo/messages';

/**
 * `@htz/mcp` dependency bundle implemented over Supabase (service role, server-only).
 * Create ONE bundle per HTTP request: the authenticated key's scopes/bindings are cached here
 * so the send gate never re-derives them from agent input.
 */

interface KeyInfo {
  orgId: string;
  scopes: Scope[];
  accountIds: string[];
  conversationIds: string[] | null;
  reqPerMin: number;
  sendPerMin: number;
}

interface ApiClientRow {
  id: string;
  org_id: string;
  name: string;
  key_prefix?: string | null;
  key_hash: string;
  scopes: string[] | null;
  account_ids: string[] | null;
  conversation_ids: string[] | null;
  rate_limit: unknown;
  expires_at: string | null;
  revoked_at?: string | null;
  legacy: boolean;
}

function perMin(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10_000 ? Math.floor(v) : def;
}

function keyInfoOf(row: ApiClientRow): KeyInfo {
  const rl = (row.rate_limit ?? {}) as Record<string, unknown>;
  return {
    orgId: row.org_id,
    scopes: (row.scopes ?? []).filter(isScope),
    accountIds: row.account_ids ?? [],
    conversationIds: row.conversation_ids,
    reqPerMin: perMin(rl.requests_per_min, 60),
    sendPerMin: perMin(rl.sends_per_min, 20),
  };
}

function toApiKeyRecord(row: ApiClientRow, prefix: string | null): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: prefix,
    keyHash: row.key_hash,
    scopes: row.scopes ?? [],
    accountIds: row.account_ids ?? [],
    conversationIds: row.conversation_ids,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
    legacy: row.legacy,
  };
}

export function toAccountRef(row: AccountRow): AccountRef {
  return {
    id: row.id,
    alias: row.alias,
    label: row.label,
    provider: row.provider,
    phoneE164: row.phone_e164,
    status: row.status,
    capabilities: capabilitiesOf(row),
    defaultUseCase: defaultUseCaseOf(row),
  };
}

/** MCP gate kinds → policy OutboundKind (see report: edit/resend are text-equivalent). */
function policyKind(ctx: McpGateContext, templatesCapable: boolean): OutboundKind {
  switch (ctx.kind) {
    case 'media':
    case 'template':
    case 'reaction':
    case 'interactive':
    case 'text':
      return ctx.kind;
    case 'reminder':
      // A reminder may be a template (allowed outside 24h); dispatch re-checks the real kind.
      return templatesCapable ? 'template' : 'text';
    default:
      return 'text';
  }
}

function entryPointFor(ctx: McpGateContext, key: KeyInfo): SendEntryPoint | null {
  if (key.scopes.includes('relay') && (ctx.tool === 'send_message' || ctx.tool === 'send_media')) {
    return 'relay.reply';
  }
  const ep = `mcp.${ctx.tool}`;
  return (SEND_ENTRY_POINTS as readonly string[]).includes(ep) ? (ep as SendEntryPoint) : null;
}

const CONNECTION_STATES: readonly ConnectionState[] = [
  'connecting',
  'open',
  'closed',
  'needs_relink',
  'conflict',
  'unconfigured',
  'paused',
];
const asConnection = (v: unknown): ConnectionState =>
  CONNECTION_STATES.includes(v as ConnectionState) ? (v as ConnectionState) : 'closed';

/* ----------------------------------------------------------------------------- automations */

interface AutomationRow {
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
  created_at: string;
  updated_at: string;
}
const AUTOMATION_COLUMNS =
  'id, account_id, name, enabled, bind_mode, status_id, keywords, match_mode, case_sensitive, ignore_emoji, reply_text, reply_media_path, options, created_at, updated_at';

function toAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    keyword: r.keywords[0] ?? '',
    match: r.match_mode,
    caseSensitive: r.case_sensitive,
    ignoreEmoji: r.ignore_emoji,
    replyText: r.reply_text ?? '',
    options: r.options ?? [],
    mediaUrl: r.reply_media_path,
    statusId: r.status_id,
    bindNextStatus: r.bind_mode === 'next_status',
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ----------------------------------------------------------------------------- reminders */

interface ReminderRow {
  id: string;
  account_id: string;
  to_e164: string;
  body: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: unknown;
  due_at: string;
  state: ReminderState;
  error_code: string | null;
  created_at: string;
}
const REMINDER_COLUMNS =
  'id, account_id, to_e164, body, template_name, template_language, template_params, due_at, state, error_code, created_at';

function toReminder(r: ReminderRow): Reminder {
  const params = Array.isArray(r.template_params)
    ? r.template_params.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    id: r.id,
    accountId: r.account_id,
    chat: e164ToJid(r.to_e164),
    text: r.body,
    template:
      r.template_name && r.template_language
        ? { name: r.template_name, language: r.template_language, params }
        : null,
    dueAt: r.due_at,
    state: r.state,
    errorCode: isGatewayErrorCode(r.error_code) ? r.error_code : null,
    createdAt: r.created_at,
  };
}

/* ----------------------------------------------------------------------------- cursor */

const encodeCursor = (offset: number) => Buffer.from(String(offset), 'utf8').toString('base64url');
function decodeCursor(c: string | null): number {
  if (!c) return 0;
  const n = Number(Buffer.from(c, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : 0;
}

/* ----------------------------------------------------------------------------- factory */

export interface McpDepsOptions {
  db?: Db;
  provider?: CloudApiProvider;
  now?: () => Date;
}

export function createMcpDeps(opts: McpDepsOptions = {}): McpDeps {
  const db = opts.db ?? serviceClient();
  const now = opts.now ?? (() => new Date());
  const keys = new Map<string, KeyInfo>();
  let provider: CloudApiProvider | null = opts.provider ?? null;
  const cloud = () => (provider ??= createCloudProvider(db));

  async function defaultOrgId(): Promise<string | null> {
    const r = await query<{ id: string } | null>(
      db.from('orgs').select('id').order('created_at').limit(1).maybeSingle(),
      'orgs.default',
    );
    return r.ok ? (r.value?.id ?? null) : null;
  }

  async function accountRef(accountId: string): Promise<Result<AccountRow>> {
    const r = await getAccount(db, accountId);
    if (!r.ok) return r;
    if (!r.value) return err(gatewayError('not_found', 'account_not_found'));
    return ok(r.value);
  }

  /** Read-intent check: account + conversation binding (no send policy). Fails closed. */
  async function bindingCheck(ctx: McpGateContext, key: KeyInfo): Promise<Result<void>> {
    if (!key.accountIds.includes(ctx.accountId)) {
      return err(gatewayError('forbidden_account', 'account_not_bound'));
    }
    if (key.conversationIds === null) {
      if (key.scopes.includes('relay'))
        return err(gatewayError('forbidden_chat', 'relay_key_unbound'));
      return ok(undefined);
    }
    const c = await getConversation(db, ctx.accountId, ctx.chat);
    if (!c.ok) return err(gatewayError('internal', 'gate_conversation_lookup_failed'));
    if (!c.value || !key.conversationIds.includes(c.value.id)) {
      return err(gatewayError('forbidden_chat', 'conversation_not_bound'));
    }
    return ok(undefined);
  }

  const deps: McpDeps = {
    now,
    randomId: () => randomUUID(),

    /* ------------------------------------------------------------- api keys (S8, R3.3) */
    apiKeys: {
      async findByPrefix(prefix) {
        const r = await rpcRow<ApiClientRow>(db, 'lookup_api_client', { p_key_prefix: prefix });
        if (!r.ok) return r;
        if (!r.value) return ok(null);
        keys.set(r.value.id, keyInfoOf(r.value));
        return ok(toApiKeyRecord(r.value, prefix));
      },
      async findLegacyByHash(keyHash) {
        if (!/^[0-9a-f]{64}$/.test(keyHash)) return ok(null);
        // Active legacy keys only (revoked / expired → no row → fail closed).
        const r = await rpcRow<ApiClientRow>(db, 'lookup_legacy_api_client', {
          p_key_hash: keyHash,
        });
        if (!r.ok) return r;
        if (!r.value) return ok(null);
        keys.set(r.value.id, keyInfoOf(r.value));
        return ok(toApiKeyRecord(r.value, null));
      },
      async touchLastUsed(id) {
        await rpc(db, 'api_client_touch', { p_id: id });
      },
    },

    /* ------------------------------------------------------------- rate limit */
    rateLimiter: {
      async take(key) {
        const m = /^(req|send):(.+)$/.exec(key);
        if (!m) throw new Error('bad_rate_key');
        const kind = m[1] as 'req' | 'send';
        const id = m[2]!;
        const info = keys.get(id);
        const cap = kind === 'req' ? (info?.reqPerMin ?? 60) : (info?.sendPerMin ?? 20);
        const r = await rpcRow<{ allowed: boolean; retry_after_ms: number }>(
          db,
          'rate_limit_take',
          {
            p_key: `apikey:${id}:${kind}`,
            p_capacity: cap,
            p_refill_per_sec: cap / 60,
            p_cost: 1,
          },
        );
        if (!r.ok || !r.value) throw new Error('rate_limiter_unavailable'); // fail closed
        return r.value.allowed
          ? { allowed: true }
          : { allowed: false, retryAfterMs: Math.max(0, r.value.retry_after_ms) };
      },
    },

    /* ------------------------------------------------------------- audit */
    audit: {
      async record(entry) {
        const orgId =
          (entry.actorId ? keys.get(entry.actorId)?.orgId : undefined) ?? (await defaultOrgId());
        if (!orgId) {
          logError('audit_no_org', { action: entry.action });
          return;
        }
        const r = await rpc(db, 'audit_append', {
          p_org_id: orgId,
          p_actor_type: 'api_client',
          p_actor_id: entry.actorId,
          p_action: entry.action,
          p_target: entry.target,
          p_ip: entry.ip && isIP(entry.ip) ? entry.ip : null,
          p_meta: {
            ...entry.meta,
            outcome: entry.outcome,
            code: entry.code,
            request_id: entry.requestId,
          },
        });
        if (!r.ok) logError('audit_append_failed', { action: entry.action });
      },
    },

    /* ------------------------------------------------------------- accounts */
    accounts: {
      async resolve(ref) {
        const r = isUuid(ref) ? await getAccount(db, ref) : await getAccountByAlias(db, ref);
        if (!r.ok) return r;
        return ok(r.value ? toAccountRef(r.value) : null);
      },
      async list(ids) {
        const r = await listAccountsByIds(db, ids);
        return r.ok ? ok(r.value.map(toAccountRef)) : r;
      },
    },

    /* ------------------------------------------------------------- messages */
    messages: {
      async enqueue(req) {
        const acc = await accountRef(req.accountId);
        if (!acc.ok) return acc;
        const account = acc.value;
        if (req.kind !== 'text' && req.kind !== 'media' && req.kind !== 'template') {
          return err(gatewayError('capability_unsupported', `kind_${req.kind}`));
        }

        // reply_to_id: a relay batch id (Lia answering), a gateway message id, or a provider id.
        let relayBatchId: string | null = null;
        let quoted: string | null = null;
        if (req.replyToId) {
          if (isUuid(req.replyToId)) {
            const b = await query<{ batch_id: string } | null>(
              db
                .from('relay_batches')
                .select('batch_id')
                .eq('batch_id', req.replyToId)
                .eq('account_id', account.id)
                .maybeSingle(),
              'relay_batches.by_id',
            );
            if (!b.ok) return b;
            if (b.value) relayBatchId = b.value.batch_id;
            else {
              const m = await findAccountMessage(db, account.id, req.replyToId);
              if (!m.ok) return m;
              quoted = m.value?.provider_message_id ?? null;
            }
          } else {
            quoted = req.replyToId;
          }
        }

        const policy = parseUseCasePolicy(account.use_case_policy);
        let text = req.text ?? null;
        if (text !== null && policy?.relay) text = markdownToWhatsApp(text);

        let media: { path: string; mime: string; caption: string | null } | null = null;
        if (req.kind === 'media') {
          const path = req.media?.storagePath ?? req.media?.url;
          if (!path || !req.media) return err(gatewayError('invalid_input', 'missing_media'));
          const caption = req.media.caption ?? null;
          media = {
            path,
            mime: req.media.mime,
            caption: caption !== null && policy?.relay ? markdownToWhatsApp(caption) : caption,
          };
        }

        const res = await enqueueAndDispatch(
          db,
          {
            accountId: account.id,
            provider: account.provider,
            chat: req.chat,
            kind: req.kind,
            text,
            media,
            template: req.template ?? null,
            quotedProviderId: quoted,
            useCase: req.useCase,
            apiClientId: req.apiClientId,
            idempotencyKey: req.idempotencyKey,
            createdBy: null,
            deliveryMode: req.kind === 'text' ? 'text' : 'native',
            requestedAt: now().toISOString(),
          },
          { wait: req.wait, provider: cloud() },
        );
        if (!res.ok) return res;

        if (relayBatchId && !res.value.duplicate) {
          const failed = res.value.row.status === 'failed';
          await rpc(db, failed ? 'relay_mark_delivery_failed' : 'relay_mark_replied', {
            p_batch_id: relayBatchId,
            ...(failed ? {} : { p_at: now().toISOString() }),
          });
        }
        return ok({ message: toMessageView(res.value.row), duplicate: res.value.duplicate });
      },

      async get(accountId, messageId) {
        const r = await findAccountMessage(db, accountId, messageId);
        if (!r.ok) return r;
        return ok(r.value ? toMessageView(r.value) : null);
      },

      async list(accountId, chat, o) {
        const c = await getConversation(db, accountId, chat);
        if (!c.ok) return c;
        if (!c.value) return ok({ items: [], nextCursor: null });
        const offset = decodeCursor(o.cursor);
        const limit = Math.min(Math.max(1, o.limit), 200);
        const r = await query<MessageRow[] | null>(
          db
            .from('messages')
            .select(MESSAGE_COLUMNS)
            .eq('conversation_id', c.value.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit),
          'messages.list',
        );
        if (!r.ok) return r;
        const rows = r.value ?? [];
        const items = rows.slice(0, limit).map(toMessageView);
        return ok({ items, nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null });
      },

      async listChats(accountId, o) {
        if (o.conversationIds !== null && o.conversationIds.length === 0) {
          return ok({ items: [], nextCursor: null });
        }
        const offset = decodeCursor(o.cursor);
        const limit = Math.min(Math.max(1, o.limit), 200);
        let q = db
          .from('conversations')
          .select(CONVERSATION_COLUMNS)
          .eq('account_id', accountId)
          .neq('type', 'status');
        if (o.conversationIds !== null) q = q.in('id', [...o.conversationIds]);
        const r = await query<ConversationRow[] | null>(
          q
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .range(offset, offset + limit),
          'conversations.list',
        );
        if (!r.ok) return r;
        const rows = r.value ?? [];
        const items: ChatView[] = rows.slice(0, limit).map((c) => ({
          conversationId: c.id,
          chat: c.chat_jid,
          type: c.type === 'group' ? 'group' : 'direct',
          title: c.title,
          lastMessageAt: c.last_message_at,
          lastInboundAt: c.last_inbound_at,
        }));
        return ok({ items, nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null });
      },

      async resend(accountId, messageId) {
        const m = await findAccountMessage(db, accountId, messageId);
        if (!m.ok) return m;
        if (!m.value) return err(gatewayError('not_found', 'message_not_found'));
        const job = await rpc<string>(db, 'message_requeue', { p_message_id: m.value.id });
        if (!job.ok) return job;
        const row = await getMessageRow(db, m.value.id);
        if (!row.ok) return row;
        if (!row.value) return err(gatewayError('not_found', 'message_not_found'));
        return ok(toMessageView(row.value));
      },

      async edit() {
        // No edit path exists yet (Graph has no edit; Baileys edit needs a worker command).
        return err(gatewayError('capability_unsupported', 'message_edit_not_implemented'));
      },

      async markRead(accountId, _chat, messageIds) {
        const acc = await accountRef(accountId);
        if (!acc.ok) return acc;
        if (acc.value.provider !== 'meta_cloud') {
          return err(gatewayError('capability_unsupported', 'mark_read_requires_worker_command'));
        }
        for (const ref of messageIds) {
          const m = await findAccountMessage(db, accountId, ref);
          if (!m.ok) return m;
          const providerId = m.value?.provider_message_id ?? (isUuid(ref) ? null : ref);
          if (!providerId) return err(gatewayError('not_found', 'message_not_found'));
          const r = await cloud().readReceipt(accountId, providerId);
          if (!r.ok) return r;
        }
        return ok(undefined);
      },
    },

    /* ------------------------------------------------------------- automations */
    automations: {
      async list(accountId, o) {
        let q = db.from('automations').select(AUTOMATION_COLUMNS).eq('account_id', accountId);
        if (o.enabled !== undefined) q = q.eq('enabled', o.enabled);
        const r = await query<AutomationRow[] | null>(q.order('created_at'), 'automations.list');
        return r.ok ? ok((r.value ?? []).map(toAutomation)) : r;
      },
      async create(accountId, input) {
        const acc = await accountRef(accountId);
        if (!acc.ok) return acc;
        const statusId = await resolveStatusId(accountId, input.statusId, input.bindNextStatus);
        if (!statusId.ok) return statusId;
        const r = await query<AutomationRow | null>(
          db
            .from('automations')
            .insert({
              org_id: acc.value.org_id,
              account_id: accountId,
              ...automationColumns(input, statusId.value),
            })
            .select(AUTOMATION_COLUMNS)
            .single(),
          'automations.create',
        );
        if (!r.ok) return r;
        if (!r.value) return err(gatewayError('internal', 'automation_insert_no_row'));
        return ok(toAutomation(r.value));
      },
      async update(accountId, id, patch) {
        if (!isUuid(id)) return err(gatewayError('not_found', 'automation_not_found'));
        const cols: Record<string, unknown> = {};
        if (patch.name !== undefined) cols.name = patch.name;
        if (patch.keyword !== undefined) cols.keywords = [patch.keyword];
        if (patch.match !== undefined) cols.match_mode = patch.match;
        if (patch.caseSensitive !== undefined) cols.case_sensitive = patch.caseSensitive;
        if (patch.ignoreEmoji !== undefined) cols.ignore_emoji = patch.ignoreEmoji;
        if (patch.replyText !== undefined) cols.reply_text = patch.replyText;
        if (patch.options !== undefined) cols.options = patch.options;
        if (patch.mediaUrl !== undefined) cols.reply_media_path = patch.mediaUrl;
        if (patch.enabled !== undefined) cols.enabled = patch.enabled;
        if (patch.statusId !== undefined || patch.bindNextStatus !== undefined) {
          const s = await resolveStatusId(
            accountId,
            patch.statusId ?? null,
            patch.bindNextStatus ?? false,
          );
          if (!s.ok) return s;
          cols.status_id = s.value;
          cols.bind_mode = s.value === null ? 'next_status' : 'status';
        }
        const r = await query<AutomationRow | null>(
          db
            .from('automations')
            .update(cols)
            .eq('id', id)
            .eq('account_id', accountId)
            .select(AUTOMATION_COLUMNS)
            .maybeSingle(),
          'automations.update',
        );
        if (!r.ok) return r;
        if (!r.value) return err(gatewayError('not_found', 'automation_not_found'));
        return ok(toAutomation(r.value));
      },
      async delete(accountId, id) {
        if (!isUuid(id)) return err(gatewayError('not_found', 'automation_not_found'));
        const r = await query<{ id: string }[] | null>(
          db.from('automations').delete().eq('id', id).eq('account_id', accountId).select('id'),
          'automations.delete',
        );
        if (!r.ok) return r;
        if (!r.value || r.value.length === 0) {
          return err(gatewayError('not_found', 'automation_not_found'));
        }
        return ok(undefined);
      },
    },

    /* ------------------------------------------------------------- reminders */
    reminders: {
      async create(req) {
        const acc = await accountRef(req.accountId);
        if (!acc.ok) return acc;
        const j = normalizeJid(req.chat);
        if (!j.ok || j.value.kind !== 'pn' || !j.value.e164) {
          return err(gatewayError('invalid_number', 'reminder_requires_phone_number'));
        }
        let state: ReminderState = 'scheduled';
        if (acc.value.provider === 'meta_cloud') {
          const c = await readCloudCredentials(db, acc.value.id);
          if (!c.ok) return c;
          if (!c.value?.accessToken || !c.value.phoneNumberId) state = 'unconfigured';
        }
        const r = await query<ReminderRow | null>(
          db
            .from('reminders')
            .insert({
              org_id: acc.value.org_id,
              account_id: acc.value.id,
              to_e164: j.value.e164,
              body: req.text,
              template_name: req.template?.name ?? null,
              template_language: req.template?.language ?? null,
              template_params: req.template?.params ?? [],
              due_at: req.dueAt,
              state,
              api_client_id: req.apiClientId,
            })
            .select(REMINDER_COLUMNS)
            .single(),
          'reminders.create',
        );
        if (!r.ok) return r;
        if (!r.value) return err(gatewayError('internal', 'reminder_insert_no_row'));
        // No idempotency column on reminders yet (see report): never claims a duplicate.
        return ok({ reminder: toReminder(r.value), duplicate: false });
      },
      async list(accountId, o) {
        let q = db.from('reminders').select(REMINDER_COLUMNS).eq('account_id', accountId);
        if (o.state) q = q.eq('state', o.state);
        const r = await query<ReminderRow[] | null>(
          q.order('due_at', { ascending: false }).limit(Math.min(Math.max(1, o.limit), 200)),
          'reminders.list',
        );
        return r.ok ? ok((r.value ?? []).map(toReminder)) : r;
      },
      async cancel(accountId, id) {
        if (!isUuid(id)) return err(gatewayError('not_found', 'reminder_not_found'));
        const cur = await query<ReminderRow | null>(
          db
            .from('reminders')
            .select(REMINDER_COLUMNS)
            .eq('id', id)
            .eq('account_id', accountId)
            .maybeSingle(),
          'reminders.get',
        );
        if (!cur.ok) return cur;
        if (!cur.value) return err(gatewayError('not_found', 'reminder_not_found'));
        if (cur.value.state !== 'scheduled' && cur.value.state !== 'unconfigured') {
          return err(gatewayError('conflict', `reminder_already_${cur.value.state}`));
        }
        const r = await query<ReminderRow | null>(
          db
            .from('reminders')
            .update({ state: 'cancelled', cancelled_at: now().toISOString() })
            .eq('id', id)
            .eq('account_id', accountId)
            .in('state', ['scheduled', 'unconfigured'])
            .select(REMINDER_COLUMNS)
            .maybeSingle(),
          'reminders.cancel',
        );
        if (!r.ok) return r;
        if (!r.value) return err(gatewayError('conflict', 'reminder_state_changed'));
        return ok(toReminder(r.value));
      },
    },

    /* ------------------------------------------------------------- sessions (R3.8) */
    sessions: {
      async status(accountId) {
        const acc = await accountRef(accountId);
        if (!acc.ok) return acc;
        const s = await query<{
          connection: string;
          connected_at: string | null;
          last_heartbeat_at: string | null;
          last_error_code: string | null;
        } | null>(
          db
            .from('sessions')
            .select('connection, connected_at, last_heartbeat_at, last_error_code')
            .eq('account_id', accountId)
            .maybeSingle(),
          'sessions.get',
        );
        if (!s.ok) return s;
        // Explicit whitelist: no QR, auth state, tokens or worker internals.
        const health: SessionHealth = {
          accountId,
          provider: acc.value.provider,
          connection: asConnection(s.value?.connection ?? acc.value.status),
          connectedAt: s.value?.connected_at ?? null,
          lastHeartbeatAt: s.value?.last_heartbeat_at ?? null,
          lastErrorCode: s.value?.last_error_code ?? null,
        };
        return ok(health);
      },
      async requestReconnect(accountId) {
        const r = await rpc<string>(db, 'request_session_command', {
          p_account_id: accountId,
          p_command: 'reconnect',
          p_requested_by: null,
          p_via: 'mcp',
        });
        return r.ok ? ok({ commandId: r.value }) : r;
      },
    },

    /* ------------------------------------------------------------- templates & groups */
    templates: {
      async list(accountId, filter) {
        const c = await readCloudCredentials(db, accountId);
        if (!c.ok) return c;
        if (!c.value?.wabaId || !c.value.accessToken) {
          return err(gatewayError('provider_unconfigured', 'cloud_credentials_missing'));
        }
        const r = await listTemplates(new GraphClient(), {
          wabaId: c.value.wabaId,
          accessToken: c.value.accessToken,
        });
        if (!r.ok) return r;
        const f: Parameters<typeof filterTemplates>[1] = {};
        if (filter.name) f.name = filter.name;
        if (filter.language) f.language = filter.language;
        if (filter.category) f.category = filter.category.toUpperCase() as TemplateCategory;
        const out: TemplateView[] = filterTemplates(r.value, f).map((t) => ({
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          paramCount: t.bodyParamCount,
        }));
        return ok(out);
      },
    },
    groups: {
      async list(accountId) {
        const r = await query<ConversationRow[] | null>(
          db
            .from('conversations')
            .select(CONVERSATION_COLUMNS)
            .eq('account_id', accountId)
            .eq('type', 'group')
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(500),
          'groups.list',
        );
        if (!r.ok) return r;
        return ok(
          (r.value ?? []).map((c) => ({ jid: c.chat_jid, subject: c.title, participants: null })),
        );
      },
    },

    /* ------------------------------------------------------------- THE send gate (S13, L2.3) */
    async sendGate(ctx) {
      const key = keys.get(ctx.apiClientId);
      if (!key) return err(gatewayError('internal', 'gate_key_context_missing'));
      if (ctx.intent === 'read' || ctx.kind === 'mark_read') return bindingCheck(ctx, key);

      const entryPoint = entryPointFor(ctx, key);
      if (!entryPoint) return err(gatewayError('internal', 'gate_unknown_entry_point'));
      const acc = await getAccount(db, ctx.accountId);
      if (!acc.ok) return err(gatewayError('internal', 'gate_account_lookup_failed'));
      if (!acc.value) return err(gatewayError('forbidden_account', 'account_not_found'));
      const r = await checkSend(
        db,
        {
          entryPoint,
          accountId: ctx.accountId,
          chat: ctx.chat,
          kind: policyKind(ctx, capabilitiesOf(acc.value).templates),
          useCase: ctx.useCase,
          actor: {
            type: 'api_client',
            clientId: ctx.apiClientId,
            scopes: key.scopes,
            accountIds: key.accountIds,
            conversationIds: key.conversationIds,
          },
        },
        now(),
      );
      return r.ok ? ok(undefined) : r;
    },
  };

  async function resolveStatusId(
    accountId: string,
    statusRef: string | null,
    bindNext: boolean,
  ): Promise<Result<string | null>> {
    if (statusRef === null) {
      return bindNext
        ? ok(null)
        : err(gatewayError('invalid_input', 'status_id_or_bind_next_status_required'));
    }
    let q = db.from('statuses').select('id').eq('account_id', accountId);
    q = isUuid(statusRef) ? q.eq('id', statusRef) : q.eq('provider_status_id', statusRef);
    const r = await query<{ id: string } | null>(q.maybeSingle(), 'statuses.resolve');
    if (!r.ok) return r;
    if (!r.value) return err(gatewayError('not_found', 'status_not_found'));
    return ok(r.value.id);
  }

  return deps;
}

function automationColumns(
  input: AutomationInput,
  statusId: string | null,
): Record<string, unknown> {
  return {
    name: input.name,
    enabled: input.enabled,
    bind_mode: statusId === null ? 'next_status' : 'status',
    status_id: statusId,
    keywords: [input.keyword],
    match_mode: input.match,
    case_sensitive: input.caseSensitive,
    ignore_emoji: input.ignoreEmoji,
    reply_text: input.replyText,
    reply_media_path: input.mediaUrl,
    options: input.options,
  };
}
