import type {
  Capabilities,
  GatewayErrorCode,
  MessageStatus,
  OutboundKind,
  ProviderKind,
  Result,
  SessionHealth,
  UseCase,
} from '@htz/core';

/**
 * Everything the MCP handlers touch is behind these interfaces. `apps/web` implements
 * them over Supabase RPCs; `src/testing/` has in-memory fakes. Every method returns a
 * `Result` (or a plain value for pure-in-memory ones); a thrown error is treated as a
 * failure and the request fails closed.
 */

/* ------------------------------------------------------------------ API keys (S8, R3.3) */

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** `null` for imported legacy tokens (looked up by hash). */
  keyPrefix: string | null;
  /** Lowercase hex SHA-256 of the full plaintext token (see `hashApiKey`). */
  keyHash: string;
  scopes: readonly string[];
  /** Accounts this key may act on (ids). */
  accountIds: readonly string[];
  /** `null` = any chat on the bound accounts; otherwise only these conversations. */
  conversationIds: readonly string[] | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Imported from WhatsApp-Automation (flagged "legacy, rotate" in the dashboard). */
  legacy: boolean;
}

export interface ApiKeyRepo {
  findByPrefix(prefix: string): Promise<Result<ApiKeyRecord | null>>;
  /** Legacy tokens had no prefix: lookup by SHA-256 hex of the whole token. */
  findLegacyByHash(keyHash: string): Promise<Result<ApiKeyRecord | null>>;
  /** Best effort; failures are ignored. */
  touchLastUsed?(id: string): Promise<void>;
}

/* ------------------------------------------------------------------ rate limit (S8) */

export type RateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /**
   * Takes one token from bucket `key`. Keys used: `req:<apiClientId>` per HTTP request,
   * `send:<apiClientId>` per send-type tool call.
   */
  take(key: string): Promise<RateDecision>;
}

/* ------------------------------------------------------------------ audit */

export type AuditOutcome = 'ok' | 'rejected' | 'error';

export interface AuditEntry {
  actorType: 'api_client';
  /** `null` when the caller could not be authenticated. */
  actorId: string | null;
  /** `mcp.<tool>` or `mcp.auth` */
  action: string;
  /** Account id the call targeted, when resolved. */
  target: string | null;
  outcome: AuditOutcome;
  code: GatewayErrorCode | null;
  /** Redacted/hashed arguments: bodies are hashed, phone numbers masked. */
  meta: Record<string, unknown>;
  ip: string | null;
  requestId: string;
  at: string;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/* ------------------------------------------------------------------ accounts */

export interface AccountRef {
  id: string;
  /** Migration alias (`default` / `meta-default`) or null. */
  alias: string | null;
  label: string;
  provider: ProviderKind;
  /** Display only; never full number in logs. */
  phoneE164: string | null;
  status: string;
  capabilities: Capabilities;
  /** Use case assumed when a tool does not specify one. */
  defaultUseCase: UseCase;
}

export interface AccountsRepo {
  /** Resolve by account id or alias. */
  resolve(ref: string): Promise<Result<AccountRef | null>>;
  /** Accounts by ids (unknown ids are skipped). */
  list(ids: readonly string[]): Promise<Result<AccountRef[]>>;
}

/* ------------------------------------------------------------------ messages */

export interface MessageView {
  id: string;
  accountId: string;
  conversationId: string | null;
  chat: string;
  direction: 'in' | 'out';
  kind: OutboundKind | 'edit' | 'unknown';
  text: string | null;
  status: MessageStatus;
  deliveryMode: 'native' | 'fallback' | 'text' | null;
  providerMessageId: string | null;
  replyToId: string | null;
  errorCode: GatewayErrorCode | null;
  clientMsgId: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface EnqueueMedia {
  /** https URL (validated by the app's outbound-url guard) or a Storage path. */
  url?: string;
  storagePath?: string;
  mime: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface EnqueueRequest {
  apiClientId: string;
  accountId: string;
  /** Normalised chat JID. */
  chat: string;
  kind: OutboundKind;
  text?: string;
  media?: EnqueueMedia;
  template?: { name: string; language: string; params: string[] };
  /** Gateway message id or provider message id being replied to. */
  replyToId?: string;
  /** `null` = no dedup (R3.6). */
  clientMsgId: string | null;
  /** Always set: `clientMsgId` scoped to the key, or a random key when absent. */
  idempotencyKey: string;
  useCase: UseCase;
  /** Wait up to ~5s for `sent` (Baileys path). */
  wait: boolean;
}

export interface ChatView {
  conversationId: string;
  chat: string;
  type: 'direct' | 'group';
  title: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MessagesService {
  /**
   * Insert `messages(queued)` (+ queue job / direct Cloud send) with
   * `ON CONFLICT (api_client_id, idempotency_key)` returning the existing row
   * (`duplicate: true`). Must be safe under concurrent calls (R3.5).
   */
  enqueue(req: EnqueueRequest): Promise<Result<{ message: MessageView; duplicate: boolean }>>;
  get(accountId: string, messageId: string): Promise<Result<MessageView | null>>;
  /** Paged history of one chat, newest first. */
  list(
    accountId: string,
    chat: string,
    opts: { cursor: string | null; limit: number },
  ): Promise<Result<Page<MessageView>>>;
  listChats(
    accountId: string,
    opts: { cursor: string | null; limit: number; conversationIds: readonly string[] | null },
  ): Promise<Result<Page<ChatView>>>;
  /** New attempt in the same idempotency lineage (§8.2). */
  resend(accountId: string, messageId: string, apiClientId: string): Promise<Result<MessageView>>;
  /** Edit a previously sent outbound message (legacy `update_reply`). */
  edit(
    accountId: string,
    messageId: string,
    text: string,
    apiClientId: string,
  ): Promise<Result<MessageView>>;
  markRead(accountId: string, chat: string, messageIds: readonly string[]): Promise<Result<void>>;
}

/* ------------------------------------------------------------------ automations (legacy) */

export type MatchMode = 'exact' | 'contains';

export interface AutomationInput {
  name: string;
  keyword: string;
  match: MatchMode;
  caseSensitive: boolean;
  ignoreEmoji: boolean;
  replyText: string;
  options: string[];
  mediaUrl: string | null;
  /** Bound status id, or null with `bindNextStatus` true for "next status I post". */
  statusId: string | null;
  bindNextStatus: boolean;
  enabled: boolean;
}

export interface Automation extends AutomationInput {
  id: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationsRepo {
  list(accountId: string, opts: { enabled?: boolean }): Promise<Result<Automation[]>>;
  create(accountId: string, input: AutomationInput): Promise<Result<Automation>>;
  update(
    accountId: string,
    id: string,
    patch: Partial<AutomationInput>,
  ): Promise<Result<Automation>>;
  delete(accountId: string, id: string): Promise<Result<void>>;
}

/* ------------------------------------------------------------------ reminders (legacy) */

export type ReminderState =
  | 'scheduled'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'unconfigured'
  | 'cancelled';

export interface Reminder {
  id: string;
  accountId: string;
  chat: string;
  text: string | null;
  template: { name: string; language: string; params: string[] } | null;
  dueAt: string;
  state: ReminderState;
  errorCode: GatewayErrorCode | null;
  createdAt: string;
}

export interface CreateReminder {
  apiClientId: string;
  accountId: string;
  chat: string;
  text: string | null;
  template: { name: string; language: string; params: string[] } | null;
  dueAt: string;
  clientMsgId: string | null;
  idempotencyKey: string;
}

export interface RemindersRepo {
  create(req: CreateReminder): Promise<Result<{ reminder: Reminder; duplicate: boolean }>>;
  list(
    accountId: string,
    opts: { state?: ReminderState; limit: number },
  ): Promise<Result<Reminder[]>>;
  /** `conflict` when already sent (R4.6). */
  cancel(accountId: string, id: string): Promise<Result<Reminder>>;
}

/* ------------------------------------------------------------------ sessions (R3.8) */

export interface SessionsService {
  /** Must never include QR, auth state, tokens or secrets; the MCP layer also whitelists fields. */
  status(accountId: string): Promise<Result<SessionHealth>>;
  /** Inserts a `session_commands(reconnect)` row the worker consumes. */
  requestReconnect(accountId: string, requestedBy: string): Promise<Result<{ commandId: string }>>;
}

/* ------------------------------------------------------------------ templates & groups */

export interface TemplateView {
  name: string;
  language: string;
  category: string;
  status: string;
  paramCount: number;
}

export interface TemplatesService {
  list(
    accountId: string,
    filter: { language?: string; category?: string; name?: string },
  ): Promise<Result<TemplateView[]>>;
}

export interface GroupView {
  jid: string;
  subject: string | null;
  participants: number | null;
}

export interface GroupsService {
  list(accountId: string): Promise<Result<GroupView[]>>;
}

/* ------------------------------------------------------------------ send gate (S13 / L2.1) */

export type SendIntent = 'send' | 'read';

export interface SendGateContext {
  intent: SendIntent;
  tool: string;
  apiClientId: string;
  accountId: string;
  provider: ProviderKind;
  /** Normalised chat JID. */
  chat: string;
  /** Key's conversation binding (`null` = unrestricted). */
  conversationIds: readonly string[] | null;
  kind: OutboundKind | 'edit' | 'resend' | 'reminder' | 'mark_read' | 'read';
  useCase: UseCase;
}

/**
 * The single policy gate (`policy.assertChatAllowed`, wired by the app). Called exactly once
 * per send-type tool call before any side effect; also for chat-scoped reads (intent `read`).
 */
export type SendGate = (ctx: SendGateContext) => Result<void> | Promise<Result<void>>;

/* ------------------------------------------------------------------ bundle */

export interface McpDeps {
  apiKeys: ApiKeyRepo;
  rateLimiter: RateLimiter;
  audit: AuditSink;
  accounts: AccountsRepo;
  messages: MessagesService;
  automations: AutomationsRepo;
  reminders: RemindersRepo;
  sessions: SessionsService;
  templates: TemplatesService;
  groups: GroupsService;
  sendGate: SendGate;
  now?: () => Date;
  /** Random id source (request ids, non-dedup idempotency keys). */
  randomId?: () => string;
}
