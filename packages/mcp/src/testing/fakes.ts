/**
 * In-memory fakes for every MCP dependency. Used by this package's tests and reusable by
 * app tests (`import { createFakeDeps } from '@htz/mcp/testing'`). Fictitious data only.
 */
import {
  BAILEYS_CAPABILITIES,
  CLOUD_CAPABILITIES,
  err,
  gatewayError,
  ok,
  type Result,
  type SessionHealth,
} from '@htz/core';
import { generateApiKey, hashApiKey } from '../auth';
import type {
  AccountRef,
  AccountsRepo,
  ApiKeyRecord,
  ApiKeyRepo,
  AuditEntry,
  AuditSink,
  Automation,
  AutomationInput,
  AutomationsRepo,
  ChatView,
  CreateReminder,
  EnqueueRequest,
  GroupView,
  GroupsService,
  McpDeps,
  MessagesService,
  MessageView,
  Page,
  RateDecision,
  RateLimiter,
  Reminder,
  RemindersRepo,
  SendGate,
  SendGateContext,
  SessionsService,
  TemplatesService,
  TemplateView,
} from '../deps';
import { LEGACY_SCOPES, SCOPES, type Scope } from '@htz/core';

export const FIXED_NOW = new Date('2026-10-21T10:00:00.000Z');
/** Fictitious test number. */
export const TEST_E164 = '+972559014410';
export const TEST_JID = '972559014410@s.whatsapp.net';
export const OTHER_JID = '972559014411@s.whatsapp.net';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ api keys */

export class InMemoryApiKeyRepo implements ApiKeyRepo {
  readonly records: ApiKeyRecord[] = [];
  failWith: 'error' | 'throw' | null = null;
  touched: string[] = [];

  issue(
    opts: Partial<Omit<ApiKeyRecord, 'keyHash' | 'keyPrefix'>> & { scopes?: readonly Scope[] } = {},
  ): { token: string; record: ApiKeyRecord } {
    const k = generateApiKey();
    const record: ApiKeyRecord = {
      id: opts.id ?? `key-${this.records.length + 1}`,
      name: opts.name ?? 'test key',
      keyPrefix: k.prefix,
      keyHash: k.hash,
      scopes: opts.scopes ?? [...SCOPES.filter((s) => s !== 'relay')],
      accountIds: opts.accountIds ?? ['acc-baileys', 'acc-cloud'],
      conversationIds: opts.conversationIds ?? null,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
      legacy: false,
    };
    this.records.push(record);
    return { token: k.token, record };
  }

  /** Imports a legacy (prefix-less) token by hash, with all 7 legacy scopes (§9.3). */
  importLegacy(token: string, opts: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
    const record: ApiKeyRecord = {
      id: opts.id ?? `legacy-${this.records.length + 1}`,
      name: 'legacy agent token',
      keyPrefix: null,
      keyHash: hashApiKey(token),
      scopes: [...LEGACY_SCOPES],
      accountIds: opts.accountIds ?? ['acc-baileys', 'acc-cloud'],
      conversationIds: null,
      expiresAt: null,
      revokedAt: null,
      legacy: true,
      ...opts,
    };
    this.records.push(record);
    return record;
  }

  private guard(): Result<void> | 'throw' {
    if (this.failWith === 'throw') return 'throw';
    if (this.failWith === 'error') return err(gatewayError('internal', 'db_down'));
    return ok(undefined);
  }

  async findByPrefix(prefix: string): Promise<Result<ApiKeyRecord | null>> {
    const g = this.guard();
    if (g === 'throw') throw new Error('db down');
    if (!g.ok) return g;
    return ok(this.records.find((r) => r.keyPrefix === prefix) ?? null);
  }

  async findLegacyByHash(keyHash: string): Promise<Result<ApiKeyRecord | null>> {
    const g = this.guard();
    if (g === 'throw') throw new Error('db down');
    if (!g.ok) return g;
    return ok(this.records.find((r) => r.keyPrefix === null && r.keyHash === keyHash) ?? null);
  }

  async touchLastUsed(id: string): Promise<void> {
    this.touched.push(id);
  }
}

/* ------------------------------------------------------------------ rate limit, audit, gate */

export class FakeRateLimiter implements RateLimiter {
  readonly taken: string[] = [];
  /** Keys (exact or prefix ending with ':') that are denied. */
  deny = new Map<string, number>();
  throws = false;

  async take(key: string): Promise<RateDecision> {
    if (this.throws) throw new Error('limiter down');
    this.taken.push(key);
    for (const [k, ms] of this.deny) {
      if (key === k || (k.endsWith(':') && key.startsWith(k)))
        return { allowed: false, retryAfterMs: ms };
    }
    return { allowed: true };
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export interface RecordingGate {
  gate: SendGate;
  calls: SendGateContext[];
  /** Replace the decision function. */
  decide: (ctx: SendGateContext) => Result<void>;
}

/** Gate that records calls; default allows everything. */
export function recordingGate(decide?: (ctx: SendGateContext) => Result<void>): RecordingGate {
  const g: RecordingGate = {
    calls: [],
    decide: decide ?? (() => ok(undefined)),
    gate: async (ctx) => {
      g.calls.push(ctx);
      return g.decide(ctx);
    },
  };
  return g;
}

/** Reference conversation-binding gate (what policy.assertChatAllowed does for keys). */
export function conversationBindingGate(
  chatToConversation: Record<string, string>,
): (ctx: SendGateContext) => Result<void> {
  return (ctx) => {
    if (ctx.conversationIds === null) return ok(undefined);
    const conv = chatToConversation[ctx.chat];
    if (conv && ctx.conversationIds.includes(conv)) return ok(undefined);
    return err(gatewayError('forbidden_chat', 'chat_not_bound'));
  };
}

/* ------------------------------------------------------------------ accounts */

export const BAILEYS_ACCOUNT: AccountRef = {
  id: 'acc-baileys',
  alias: 'default',
  label: 'Test Baileys',
  provider: 'baileys',
  phoneE164: TEST_E164,
  status: 'open',
  capabilities: BAILEYS_CAPABILITIES,
  defaultUseCase: 'agent_relay',
};

export const CLOUD_ACCOUNT: AccountRef = {
  id: 'acc-cloud',
  alias: 'meta-default',
  label: 'Test Cloud',
  provider: 'meta_cloud',
  phoneE164: null,
  status: 'open',
  capabilities: CLOUD_CAPABILITIES,
  defaultUseCase: 'reminders',
};

export class InMemoryAccountsRepo implements AccountsRepo {
  constructor(readonly accounts: AccountRef[] = [BAILEYS_ACCOUNT, CLOUD_ACCOUNT]) {}
  async resolve(ref: string): Promise<Result<AccountRef | null>> {
    return ok(this.accounts.find((a) => a.id === ref || a.alias === ref) ?? null);
  }
  async list(ids: readonly string[]): Promise<Result<AccountRef[]>> {
    return ok(this.accounts.filter((a) => ids.includes(a.id)));
  }
}

/* ------------------------------------------------------------------ messages */

export class InMemoryMessagesService implements MessagesService {
  readonly messages: MessageView[] = [];
  /** Every side effect performed (enqueue/resend/edit/markRead). */
  readonly effects: { op: string; req: unknown }[] = [];
  private readonly inflight = new Map<
    string,
    Promise<Result<{ message: MessageView; duplicate: boolean }>>
  >();
  private seq = 0;
  chats: ChatView[] = [];

  constructor(private readonly now: () => Date = () => FIXED_NOW) {}

  seed(m: Partial<MessageView> & { id: string; accountId: string; chat: string }): MessageView {
    const full: MessageView = {
      conversationId: null,
      direction: 'out',
      kind: 'text',
      text: 'seed',
      status: 'sent',
      deliveryMode: 'native',
      providerMessageId: null,
      replyToId: null,
      errorCode: null,
      clientMsgId: null,
      createdAt: this.now().toISOString(),
      sentAt: null,
      ...m,
    };
    this.messages.push(full);
    return full;
  }

  /** DB semantics: unique (api_client_id, idempotency_key) → returns the existing row. */
  enqueue(req: EnqueueRequest): Promise<Result<{ message: MessageView; duplicate: boolean }>> {
    const key = `${req.apiClientId}|${req.idempotencyKey}`;
    const pending = this.inflight.get(key);
    if (pending) return pending.then((r) => (r.ok ? ok({ ...r.value, duplicate: true }) : r));
    const p = (async () => {
      await tick(); // simulate the DB round-trip so concurrent calls overlap
      this.effects.push({ op: 'enqueue', req });
      const m = this.seed({
        id: `msg-${++this.seq}`,
        accountId: req.accountId,
        chat: req.chat,
        kind: req.kind,
        text: req.text ?? null,
        status: 'queued',
        deliveryMode: null,
        replyToId: req.replyToId ?? null,
        clientMsgId: req.clientMsgId,
      });
      return ok({ message: m, duplicate: false });
    })();
    this.inflight.set(key, p);
    return p;
  }

  async get(accountId: string, messageId: string): Promise<Result<MessageView | null>> {
    return ok(this.messages.find((m) => m.accountId === accountId && m.id === messageId) ?? null);
  }

  async list(
    accountId: string,
    chat: string,
    opts: { cursor: string | null; limit: number },
  ): Promise<Result<Page<MessageView>>> {
    const all = this.messages.filter((m) => m.accountId === accountId && m.chat === chat).reverse();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const items = all.slice(start, start + opts.limit);
    const next = start + opts.limit < all.length ? String(start + opts.limit) : null;
    return ok({ items, nextCursor: next });
  }

  async listChats(
    accountId: string,
    opts: { cursor: string | null; limit: number; conversationIds: readonly string[] | null },
  ): Promise<Result<Page<ChatView>>> {
    const ids = opts.conversationIds;
    const items = this.chats
      .filter((c) => ids === null || ids.includes(c.conversationId))
      .slice(0, opts.limit);
    void accountId;
    return ok({ items, nextCursor: null });
  }

  async resend(
    accountId: string,
    messageId: string,
    apiClientId: string,
  ): Promise<Result<MessageView>> {
    const orig = this.messages.find((m) => m.accountId === accountId && m.id === messageId);
    if (!orig) return err(gatewayError('not_found'));
    this.effects.push({ op: 'resend', req: { messageId, apiClientId } });
    return ok(this.seed({ ...orig, id: `msg-${++this.seq}`, status: 'queued', errorCode: null }));
  }

  async edit(
    accountId: string,
    messageId: string,
    text: string,
    apiClientId: string,
  ): Promise<Result<MessageView>> {
    const m = this.messages.find((x) => x.accountId === accountId && x.id === messageId);
    if (!m) return err(gatewayError('not_found'));
    this.effects.push({ op: 'edit', req: { messageId, apiClientId } });
    m.text = text;
    return ok(m);
  }

  async markRead(
    accountId: string,
    chat: string,
    messageIds: readonly string[],
  ): Promise<Result<void>> {
    this.effects.push({ op: 'markRead', req: { accountId, chat, messageIds } });
    return ok(undefined);
  }
}

/* ------------------------------------------------------------------ automations, reminders */

export class InMemoryAutomationsRepo implements AutomationsRepo {
  readonly items: Automation[] = [];
  readonly effects: string[] = [];
  async list(accountId: string, opts: { enabled?: boolean }): Promise<Result<Automation[]>> {
    return ok(
      this.items.filter(
        (a) =>
          a.accountId === accountId && (opts.enabled === undefined || a.enabled === opts.enabled),
      ),
    );
  }
  async create(accountId: string, input: AutomationInput): Promise<Result<Automation>> {
    this.effects.push('create');
    const a: Automation = {
      ...input,
      id: `auto-${this.items.length + 1}`,
      accountId,
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
    };
    this.items.push(a);
    return ok(a);
  }
  async update(
    accountId: string,
    id: string,
    patch: Partial<AutomationInput>,
  ): Promise<Result<Automation>> {
    const a = this.items.find((x) => x.accountId === accountId && x.id === id);
    if (!a) return err(gatewayError('not_found'));
    this.effects.push('update');
    Object.assign(a, patch);
    return ok(a);
  }
  async delete(accountId: string, id: string): Promise<Result<void>> {
    const i = this.items.findIndex((x) => x.accountId === accountId && x.id === id);
    if (i < 0) return err(gatewayError('not_found'));
    this.effects.push('delete');
    this.items.splice(i, 1);
    return ok(undefined);
  }
}

export class InMemoryRemindersRepo implements RemindersRepo {
  readonly items: Reminder[] = [];
  readonly effects: string[] = [];
  private readonly byKey = new Map<string, Reminder>();
  async create(req: CreateReminder): Promise<Result<{ reminder: Reminder; duplicate: boolean }>> {
    const key = `${req.apiClientId}|${req.idempotencyKey}`;
    const existing = this.byKey.get(key);
    if (existing) return ok({ reminder: existing, duplicate: true });
    this.effects.push('create');
    const r: Reminder = {
      id: `rem-${this.items.length + 1}`,
      accountId: req.accountId,
      chat: req.chat,
      text: req.text,
      template: req.template,
      dueAt: req.dueAt,
      state: 'scheduled',
      errorCode: null,
      createdAt: FIXED_NOW.toISOString(),
    };
    this.items.push(r);
    this.byKey.set(key, r);
    return ok({ reminder: r, duplicate: false });
  }
  async list(
    accountId: string,
    opts: { state?: Reminder['state']; limit: number },
  ): Promise<Result<Reminder[]>> {
    return ok(
      this.items
        .filter((r) => r.accountId === accountId && (!opts.state || r.state === opts.state))
        .slice(0, opts.limit),
    );
  }
  async cancel(accountId: string, id: string): Promise<Result<Reminder>> {
    const r = this.items.find((x) => x.accountId === accountId && x.id === id);
    if (!r) return err(gatewayError('not_found'));
    if (['sent', 'delivered', 'read'].includes(r.state)) {
      return err(gatewayError('conflict', 'already_sent'));
    }
    this.effects.push('cancel');
    r.state = 'cancelled';
    return ok(r);
  }
}

/* ------------------------------------------------------------------ sessions, templates, groups */

export class FakeSessionsService implements SessionsService {
  readonly commands: { accountId: string; requestedBy: string }[] = [];
  /** Simulates a buggy backend that leaks extra fields; the MCP layer must strip them. */
  leakSecrets = false;
  async status(accountId: string): Promise<Result<SessionHealth>> {
    const h: SessionHealth = {
      accountId,
      provider: accountId === 'acc-cloud' ? 'meta_cloud' : 'baileys',
      connection: 'open',
      connectedAt: FIXED_NOW.toISOString(),
      lastHeartbeatAt: FIXED_NOW.toISOString(),
      lastErrorCode: null,
    };
    if (this.leakSecrets) {
      Object.assign(h, {
        qr: '2@QRPAYLOAD',
        authState: { noiseKey: 'x' },
        accessToken: 'EAAGsecret',
      });
    }
    return ok(h);
  }
  async requestReconnect(
    accountId: string,
    requestedBy: string,
  ): Promise<Result<{ commandId: string }>> {
    this.commands.push({ accountId, requestedBy });
    return ok({ commandId: `cmd-${this.commands.length}` });
  }
}

export class FakeTemplatesService implements TemplatesService {
  constructor(
    readonly items: TemplateView[] = [
      {
        name: 'appointment_reminder',
        language: 'he',
        category: 'UTILITY',
        status: 'APPROVED',
        paramCount: 2,
      },
    ],
  ) {}
  async list(
    _accountId: string,
    filter: { language?: string; name?: string },
  ): Promise<Result<TemplateView[]>> {
    return ok(
      this.items.filter(
        (t) =>
          (!filter.language || t.language === filter.language) &&
          (!filter.name || t.name.includes(filter.name)),
      ),
    );
  }
}

export class FakeGroupsService implements GroupsService {
  constructor(
    readonly items: GroupView[] = [
      { jid: '120363000000000001@g.us', subject: 'Test group', participants: 3 },
    ],
  ) {}
  async list(): Promise<Result<GroupView[]>> {
    return ok(this.items);
  }
}

/* ------------------------------------------------------------------ bundle */

export interface FakeDeps {
  deps: McpDeps;
  apiKeys: InMemoryApiKeyRepo;
  rateLimiter: FakeRateLimiter;
  audit: MemoryAuditSink;
  accounts: InMemoryAccountsRepo;
  messages: InMemoryMessagesService;
  automations: InMemoryAutomationsRepo;
  reminders: InMemoryRemindersRepo;
  sessions: FakeSessionsService;
  templates: FakeTemplatesService;
  groups: FakeGroupsService;
  gate: RecordingGate;
  /** Total side effects across all fakes. */
  sideEffects(): number;
}

export function createFakeDeps(): FakeDeps {
  const f = {
    apiKeys: new InMemoryApiKeyRepo(),
    rateLimiter: new FakeRateLimiter(),
    audit: new MemoryAuditSink(),
    accounts: new InMemoryAccountsRepo(),
    messages: new InMemoryMessagesService(),
    automations: new InMemoryAutomationsRepo(),
    reminders: new InMemoryRemindersRepo(),
    sessions: new FakeSessionsService(),
    templates: new FakeTemplatesService(),
    groups: new FakeGroupsService(),
    gate: recordingGate(),
  };
  let n = 0;
  const deps: McpDeps = {
    apiKeys: f.apiKeys,
    rateLimiter: f.rateLimiter,
    audit: f.audit,
    accounts: f.accounts,
    messages: f.messages,
    automations: f.automations,
    reminders: f.reminders,
    sessions: f.sessions,
    templates: f.templates,
    groups: f.groups,
    sendGate: (ctx) => f.gate.gate(ctx),
    now: () => FIXED_NOW,
    randomId: () => `rid-${++n}`,
  };
  return {
    ...f,
    deps,
    sideEffects: () =>
      f.messages.effects.length +
      f.automations.effects.length +
      f.reminders.effects.length +
      f.sessions.commands.length,
  };
}
