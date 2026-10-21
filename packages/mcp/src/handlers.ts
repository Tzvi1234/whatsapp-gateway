import { err, gatewayError, jidKind, ok, type Result, type SessionHealth } from '@htz/core';
import type { ToolContext, ToolHandler, ToolPayload } from './context';
import type {
  AccountRef,
  Automation,
  AutomationInput,
  EnqueueRequest,
  MessageView,
  Reminder,
} from './deps';
import { throughReadGate, throughSendGate } from './send-path';
import type { ToolArgs, ToolName } from './tools';

/* ------------------------------------------------------------------ mappers (snake_case out) */

export function messageOut(m: MessageView): Record<string, unknown> {
  return {
    message_id: m.id,
    account_id: m.accountId,
    chat: m.chat,
    direction: m.direction,
    kind: m.kind,
    text: m.text,
    status: m.status,
    delivery_mode: m.deliveryMode,
    provider_message_id: m.providerMessageId,
    reply_to_id: m.replyToId,
    error_code: m.errorCode,
    client_msg_id: m.clientMsgId,
    created_at: m.createdAt,
    sent_at: m.sentAt,
  };
}

function automationOut(a: Automation): Record<string, unknown> {
  return {
    id: a.id,
    account_id: a.accountId,
    name: a.name,
    keyword: a.keyword,
    match: a.match,
    case_sensitive: a.caseSensitive,
    ignore_emoji: a.ignoreEmoji,
    reply_text: a.replyText,
    options: a.options,
    media_url: a.mediaUrl,
    status_id: a.statusId,
    bind_next_status: a.bindNextStatus,
    enabled: a.enabled,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

function reminderOut(r: Reminder): Record<string, unknown> {
  return {
    id: r.id,
    account_id: r.accountId,
    to: r.chat,
    text: r.text,
    template: r.template,
    due_at: r.dueAt,
    state: r.state,
    error_code: r.errorCode,
    created_at: r.createdAt,
  };
}

function accountOut(a: AccountRef): Record<string, unknown> {
  return {
    id: a.id,
    alias: a.alias,
    label: a.label,
    provider: a.provider,
    phone: a.phoneE164,
    status: a.status,
    capabilities: a.capabilities,
  };
}

/** R3.8: explicit whitelist so nothing else (QR, auth state, tokens) can ever leak. */
function sessionOut(s: SessionHealth): Record<string, unknown> {
  return {
    account_id: s.accountId,
    provider: s.provider,
    connection: s.connection,
    connected_at: s.connectedAt,
    last_heartbeat_at: s.lastHeartbeatAt,
    last_error_code: s.lastErrorCode,
  };
}

const done = (v: Record<string, unknown> = {}): Result<ToolPayload> => ok({ ok: true, ...v });

function unsupported(detail: string) {
  return err(gatewayError('capability_unsupported', detail));
}

function idempotency(ctx: ToolContext, clientMsgId: string | undefined) {
  ctx.auditMeta.dedup = clientMsgId !== undefined; // R3.6: logged when no dedup
  return {
    clientMsgId: clientMsgId ?? null,
    idempotencyKey: clientMsgId ?? `auto:${ctx.randomId()}`,
  };
}

async function enqueue(
  ctx: ToolContext,
  req: Omit<EnqueueRequest, 'apiClientId' | 'accountId' | 'chat'>,
  chat: string,
): Promise<Result<ToolPayload>> {
  const r = await ctx.deps.messages.enqueue({
    ...req,
    apiClientId: ctx.auth.apiClientId,
    accountId: ctx.account.id,
    chat,
  });
  if (!r.ok) return r;
  ctx.auditMeta.duplicate = r.value.duplicate;
  const m = r.value.message;
  return done({
    message_id: m.id,
    status: m.status,
    duplicate: r.value.duplicate,
    delivery_mode: m.deliveryMode,
    provider_message_id: m.providerMessageId,
  });
}

function groupGuard(ctx: ToolContext, chat: string): Result<void> {
  if (jidKind(chat) === 'group' && ctx.account.capabilities.groups === 'none') {
    return unsupported('groups_not_supported');
  }
  return ok(undefined);
}

async function loadOwnMessage(ctx: ToolContext, messageId: string): Promise<Result<MessageView>> {
  const r = await ctx.deps.messages.get(ctx.account.id, messageId);
  if (!r.ok) return r;
  if (!r.value || r.value.accountId !== ctx.account.id) {
    return err(gatewayError('not_found', 'message_not_found'));
  }
  return ok(r.value);
}

function automationInput(a: ToolArgs<'create_automation'>): AutomationInput {
  return {
    name: a.name,
    keyword: a.keyword,
    match: a.match,
    caseSensitive: a.case_sensitive,
    ignoreEmoji: a.ignore_emoji,
    replyText: a.reply_text,
    options: a.options,
    mediaUrl: a.media_url ?? null,
    statusId: a.status_id ?? null,
    bindNextStatus: a.bind_next_status,
    enabled: a.enabled,
  };
}

function automationPatch(a: ToolArgs<'update_automation'>): Partial<AutomationInput> {
  const p: Partial<AutomationInput> = {};
  if (a.name !== undefined) p.name = a.name;
  if (a.keyword !== undefined) p.keyword = a.keyword;
  if (a.match !== undefined) p.match = a.match;
  if (a.case_sensitive !== undefined) p.caseSensitive = a.case_sensitive;
  if (a.ignore_emoji !== undefined) p.ignoreEmoji = a.ignore_emoji;
  if (a.reply_text !== undefined) p.replyText = a.reply_text;
  if (a.options !== undefined) p.options = a.options;
  if (a.media_url !== undefined) p.mediaUrl = a.media_url;
  if (a.status_id !== undefined) p.statusId = a.status_id;
  if (a.bind_next_status !== undefined) p.bindNextStatus = a.bind_next_status;
  if (a.enabled !== undefined) p.enabled = a.enabled;
  return p;
}

function statusAutomationGuard(ctx: ToolContext): Result<void> {
  return ctx.account.capabilities.statusStories
    ? ok(undefined)
    : unsupported('status_automations_not_supported');
}

/* ------------------------------------------------------------------ handlers */

type Handlers = { [N in ToolName]: ToolHandler<ToolArgs<N>> };

export const HANDLERS: Handlers = {
  // ------------------------------------------------ automations
  async list_automations(ctx, a) {
    const r = await ctx.deps.automations.list(
      ctx.account.id,
      a.enabled !== undefined ? { enabled: a.enabled } : {},
    );
    if (!r.ok) return r;
    return done({ automations: r.value.map(automationOut) });
  },
  async create_automation(ctx, a) {
    const g = statusAutomationGuard(ctx);
    if (!g.ok) return g;
    if (a.status_id == null && !a.bind_next_status) {
      return err(gatewayError('invalid_input', 'status_id_or_bind_next_status_required'));
    }
    const r = await ctx.deps.automations.create(ctx.account.id, automationInput(a));
    if (!r.ok) return r;
    return done({ automation: automationOut(r.value) });
  },
  async update_automation(ctx, a) {
    const g = statusAutomationGuard(ctx);
    if (!g.ok) return g;
    const r = await ctx.deps.automations.update(ctx.account.id, a.id, automationPatch(a));
    if (!r.ok) return r;
    return done({ automation: automationOut(r.value) });
  },
  async delete_automation(ctx, a) {
    const r = await ctx.deps.automations.delete(ctx.account.id, a.id);
    if (!r.ok) return r;
    return done({ id: a.id, deleted: true });
  },

  // ------------------------------------------------ messages
  async send_message(ctx, a) {
    return throughSendGate(ctx, { chat: a.to, kind: 'text', useCase: a.use_case }, async (chat) => {
      const g = groupGuard(ctx, chat);
      if (!g.ok) return g;
      const req: Omit<EnqueueRequest, 'apiClientId' | 'accountId' | 'chat'> = {
        kind: 'text',
        text: a.text,
        ...idempotency(ctx, a.client_msg_id),
        useCase: a.use_case ?? ctx.account.defaultUseCase,
        wait: a.wait,
      };
      if (a.reply_to_id) req.replyToId = a.reply_to_id;
      return enqueue(ctx, req, chat);
    });
  },
  async update_reply(ctx, a) {
    const orig = await loadOwnMessage(ctx, a.message_id);
    if (!orig.ok) return orig;
    if (orig.value.direction !== 'out') return err(gatewayError('invalid_input', 'not_outbound'));
    return throughSendGate(ctx, { chat: orig.value.chat, kind: 'edit' }, async () => {
      const r = await ctx.deps.messages.edit(
        ctx.account.id,
        a.message_id,
        a.text,
        ctx.auth.apiClientId,
      );
      if (!r.ok) return r;
      return done({ message: messageOut(r.value) });
    });
  },
  async get_thread(ctx, a) {
    const chat = await throughReadGate(ctx, a.chat);
    if (!chat.ok) return chat;
    const r = await ctx.deps.messages.list(ctx.account.id, chat.value, {
      cursor: null,
      limit: a.limit,
    });
    if (!r.ok) return r;
    return done({ chat: chat.value, messages: r.value.items.map(messageOut) });
  },
  async send_media(ctx, a) {
    if (!ctx.account.capabilities.media) return unsupported('media_not_supported');
    if (a.voice && !ctx.account.capabilities.voiceNotes) return unsupported('voice_not_supported');
    return throughSendGate(
      ctx,
      { chat: a.to, kind: 'media', useCase: a.use_case },
      async (chat) => {
        const g = groupGuard(ctx, chat);
        if (!g.ok) return g;
        const media: NonNullable<EnqueueRequest['media']> = { mime: a.mime };
        if (a.url !== undefined) media.url = a.url;
        if (a.storage_path !== undefined) media.storagePath = a.storage_path;
        if (a.caption !== undefined) media.caption = a.caption;
        if (a.filename !== undefined) media.filename = a.filename;
        if (a.voice !== undefined) media.voice = a.voice;
        const req: Omit<EnqueueRequest, 'apiClientId' | 'accountId' | 'chat'> = {
          kind: 'media',
          media,
          ...idempotency(ctx, a.client_msg_id),
          useCase: a.use_case ?? ctx.account.defaultUseCase,
          wait: a.wait,
        };
        if (a.reply_to_id) req.replyToId = a.reply_to_id;
        return enqueue(ctx, req, chat);
      },
    );
  },
  async send_template(ctx, a) {
    if (!ctx.account.capabilities.templates) return unsupported('templates_not_supported');
    return throughSendGate(ctx, { chat: a.to, kind: 'template', useCase: a.use_case }, (chat) =>
      enqueue(
        ctx,
        {
          kind: 'template',
          template: { name: a.name, language: a.language, params: a.params },
          ...idempotency(ctx, a.client_msg_id),
          useCase: a.use_case ?? ctx.account.defaultUseCase,
          wait: false,
        },
        chat,
      ),
    );
  },
  async send_group_message(ctx, a) {
    if (ctx.account.capabilities.groups === 'none') return unsupported('groups_not_supported');
    return throughSendGate(ctx, { chat: a.group, kind: 'text', useCase: a.use_case }, (chat) => {
      const req: Omit<EnqueueRequest, 'apiClientId' | 'accountId' | 'chat'> = {
        kind: 'text',
        text: a.text,
        ...idempotency(ctx, a.client_msg_id),
        useCase: a.use_case ?? ctx.account.defaultUseCase,
        wait: a.wait,
      };
      if (a.reply_to_id) req.replyToId = a.reply_to_id;
      return enqueue(ctx, req, chat);
    });
  },
  async resend_message(ctx, a) {
    const orig = await loadOwnMessage(ctx, a.message_id);
    if (!orig.ok) return orig;
    if (orig.value.direction !== 'out') return err(gatewayError('invalid_input', 'not_outbound'));
    if (orig.value.status !== 'failed' && orig.value.status !== 'cancelled') {
      return err(gatewayError('conflict', `not_resendable_${orig.value.status}`));
    }
    return throughSendGate(ctx, { chat: orig.value.chat, kind: 'resend' }, async () => {
      const r = await ctx.deps.messages.resend(ctx.account.id, a.message_id, ctx.auth.apiClientId);
      if (!r.ok) return r;
      return done({ message: messageOut(r.value), resent_from: a.message_id });
    });
  },
  async mark_read(ctx, a) {
    if (!ctx.account.capabilities.readReceipts) return unsupported('read_receipts_not_supported');
    return throughSendGate(ctx, { chat: a.chat, kind: 'mark_read' }, async (chat) => {
      const r = await ctx.deps.messages.markRead(ctx.account.id, chat, a.message_ids);
      if (!r.ok) return r;
      return done({ chat, marked: a.message_ids.length });
    });
  },
  async list_chats(ctx, a) {
    const r = await ctx.deps.messages.listChats(ctx.account.id, {
      cursor: a.cursor ?? null,
      limit: a.limit,
      conversationIds: ctx.auth.conversationIds,
    });
    if (!r.ok) return r;
    return done({
      chats: r.value.items.map((c) => ({
        conversation_id: c.conversationId,
        chat: c.chat,
        type: c.type,
        title: c.title,
        last_message_at: c.lastMessageAt,
        last_inbound_at: c.lastInboundAt,
      })),
      next_cursor: r.value.nextCursor,
    });
  },
  async get_messages(ctx, a) {
    const chat = await throughReadGate(ctx, a.chat);
    if (!chat.ok) return chat;
    const r = await ctx.deps.messages.list(ctx.account.id, chat.value, {
      cursor: a.cursor ?? null,
      limit: a.limit,
    });
    if (!r.ok) return r;
    return done({
      chat: chat.value,
      messages: r.value.items.map(messageOut),
      next_cursor: r.value.nextCursor,
    });
  },
  async get_message(ctx, a) {
    const m = await loadOwnMessage(ctx, a.message_id);
    if (!m.ok) return m;
    const g = await throughReadGate(ctx, m.value.chat);
    if (!g.ok) return g;
    return done({ message: messageOut(m.value) });
  },
  async get_message_status(ctx, a) {
    const m = await loadOwnMessage(ctx, a.message_id);
    if (!m.ok) return m;
    const g = await throughReadGate(ctx, m.value.chat);
    if (!g.ok) return g;
    return done({
      message_id: m.value.id,
      status: m.value.status,
      delivery_mode: m.value.deliveryMode,
      error_code: m.value.errorCode,
      sent_at: m.value.sentAt,
    });
  },

  // ------------------------------------------------ reminders
  async send_reminder(ctx, a) {
    return throughSendGate(
      ctx,
      { chat: a.to, kind: 'reminder', useCase: 'reminders' },
      async (chat) => {
        const g = groupGuard(ctx, chat);
        if (!g.ok) return g;
        const r = await ctx.deps.reminders.create({
          apiClientId: ctx.auth.apiClientId,
          accountId: ctx.account.id,
          chat,
          text: a.text ?? null,
          template: a.template ?? null,
          dueAt: a.due_at ?? ctx.now.toISOString(),
          ...idempotency(ctx, a.client_msg_id),
        });
        if (!r.ok) return r;
        ctx.auditMeta.duplicate = r.value.duplicate;
        return done({ reminder: reminderOut(r.value.reminder), duplicate: r.value.duplicate });
      },
    );
  },
  async list_reminders(ctx, a) {
    const r = await ctx.deps.reminders.list(
      ctx.account.id,
      a.state !== undefined ? { state: a.state, limit: a.limit } : { limit: a.limit },
    );
    if (!r.ok) return r;
    return done({ reminders: r.value.map(reminderOut) });
  },
  async cancel_reminder(ctx, a) {
    const r = await ctx.deps.reminders.cancel(ctx.account.id, a.id);
    if (!r.ok) return r;
    return done({ reminder: reminderOut(r.value) });
  },

  // ------------------------------------------------ sessions
  async session_status(ctx) {
    const r = await ctx.deps.sessions.status(ctx.account.id);
    if (!r.ok) return r;
    return done({ account: ctx.account.alias ?? ctx.account.id, session: sessionOut(r.value) });
  },
  async session_reconnect(ctx) {
    const r = await ctx.deps.sessions.requestReconnect(ctx.account.id, ctx.auth.apiClientId);
    if (!r.ok) return r;
    return done({
      account: ctx.account.alias ?? ctx.account.id,
      command_id: r.value.commandId,
      requested: true,
    });
  },

  // ------------------------------------------------ accounts, templates, groups
  async list_accounts(ctx) {
    const r = await ctx.deps.accounts.list(ctx.auth.accountIds);
    if (!r.ok) return r;
    const allowed = new Set(ctx.auth.accountIds);
    return done({ accounts: r.value.filter((x) => allowed.has(x.id)).map(accountOut) });
  },
  async get_capabilities(ctx) {
    return done({
      account: ctx.account.alias ?? ctx.account.id,
      provider: ctx.account.provider,
      capabilities: ctx.account.capabilities,
    });
  },
  async list_templates(ctx, a) {
    if (!ctx.account.capabilities.templates) return unsupported('templates_not_supported');
    const filter: { language?: string; category?: string; name?: string } = {};
    if (a.language !== undefined) filter.language = a.language;
    if (a.category !== undefined) filter.category = a.category;
    if (a.name !== undefined) filter.name = a.name;
    const r = await ctx.deps.templates.list(ctx.account.id, filter);
    if (!r.ok) return r;
    return done({
      templates: r.value.map((t) => ({
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        param_count: t.paramCount,
      })),
    });
  },
  async list_groups(ctx) {
    if (ctx.account.capabilities.groups === 'none') return unsupported('groups_not_supported');
    const r = await ctx.deps.groups.list(ctx.account.id);
    if (!r.ok) return r;
    let groups = r.value;
    if (ctx.auth.conversationIds !== null) groups = []; // conversation-bound keys see no group list
    return done({
      groups: groups.map((g) => ({ jid: g.jid, subject: g.subject, participants: g.participants })),
    });
  },
};
