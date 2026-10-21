import { z } from 'zod';
import { USE_CASES, type Scope } from '@htz/core';

/**
 * MCP tool definitions. The 12 legacy (v1) tools keep their exact names and params
 * (frozen by the `tools/list` snapshot test, R3.1); new tools take an optional `account`.
 * Params are lenient (unknown keys are ignored) so older agent configs keep working.
 */

const account = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Account id or alias. Omitted: the migration alias `default` (Baileys) or `meta-default` (Cloud API).',
  );
const to = z
  .string()
  .min(3)
  .max(100)
  .describe('Recipient: E.164 / Israeli local number or WhatsApp JID.');
const chat = z.string().min(3).max(100).describe('Chat: phone number or WhatsApp JID.');
const text = z.string().min(1).max(4096);
const clientMsgId = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    'Idempotency key: the same value twice returns the first result without a second send.',
  );
const replyToId = z.string().min(1).max(256).optional().describe('Message id to quote/reply to.');
const wait = z
  .boolean()
  .default(false)
  .describe('Wait up to ~5s for the message to reach status `sent`.');
const useCase = z
  .enum(USE_CASES)
  .optional()
  .describe("Use case; defaults to the account's default.");
const limit = (def: number, max: number) => z.number().int().min(1).max(max).default(def);
const cursor = z.string().min(1).max(512).optional();
const id = z.string().min(1).max(128);
const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/, 'must be an https URL');
const reminderStates = [
  'scheduled',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'unconfigured',
  'cancelled',
] as const;

const automationFields = {
  name: z.string().min(1).max(100),
  keyword: z.string().min(1).max(200),
  match: z.enum(['exact', 'contains']),
  case_sensitive: z.boolean(),
  ignore_emoji: z.boolean(),
  reply_text: z.string().min(1).max(4096),
  options: z.array(z.string().min(1).max(200)).max(10),
  media_url: httpsUrl.nullable(),
  status_id: z.string().min(1).max(256).nullable(),
  bind_next_status: z.boolean(),
  enabled: z.boolean(),
};

export const TOOL_SCHEMAS = {
  // ---------------------------------------------------------------- legacy v1 (frozen)
  list_automations: z.object({ account, enabled: z.boolean().optional() }),
  create_automation: z.object({
    account,
    name: automationFields.name,
    keyword: automationFields.keyword,
    match: automationFields.match.default('contains'),
    case_sensitive: automationFields.case_sensitive.default(false),
    ignore_emoji: automationFields.ignore_emoji.default(true),
    reply_text: automationFields.reply_text,
    options: automationFields.options.default([]),
    media_url: automationFields.media_url.optional(),
    status_id: automationFields.status_id.optional(),
    bind_next_status: automationFields.bind_next_status.default(false),
    enabled: automationFields.enabled.default(true),
  }),
  update_automation: z.object({
    account,
    id,
    name: automationFields.name.optional(),
    keyword: automationFields.keyword.optional(),
    match: automationFields.match.optional(),
    case_sensitive: automationFields.case_sensitive.optional(),
    ignore_emoji: automationFields.ignore_emoji.optional(),
    reply_text: automationFields.reply_text.optional(),
    options: automationFields.options.optional(),
    media_url: automationFields.media_url.optional(),
    status_id: automationFields.status_id.optional(),
    bind_next_status: automationFields.bind_next_status.optional(),
    enabled: automationFields.enabled.optional(),
  }),
  delete_automation: z.object({ account, id }),
  send_message: z.object({
    to,
    text,
    reply_to_id: replyToId,
    client_msg_id: clientMsgId,
    account,
    wait,
    use_case: useCase,
  }),
  update_reply: z.object({
    message_id: id.describe('Id of an outbound message sent earlier.'),
    text,
    account,
  }),
  get_thread: z.object({ chat, limit: limit(50, 200), account }),
  send_reminder: z
    .object({
      to,
      text: text.optional(),
      due_at: z.iso.datetime({ offset: true }).optional().describe('ISO time; omitted = now.'),
      template: z
        .object({
          name: z.string().min(1).max(512),
          language: z.string().min(2).max(15).default('he'),
          params: z.array(z.string().max(1024)).max(20).default([]),
        })
        .optional(),
      client_msg_id: clientMsgId,
      account,
    })
    .refine((v) => v.text !== undefined || v.template !== undefined, {
      message: 'text or template is required',
      path: ['text'],
    }),
  list_reminders: z.object({
    account,
    state: z.enum(reminderStates).optional(),
    limit: limit(50, 200),
  }),
  cancel_reminder: z.object({ id, account }),
  session_status: z.object({ account }),
  session_reconnect: z.object({ account }),

  // ---------------------------------------------------------------- extensions
  list_accounts: z.object({}),
  send_media: z
    .object({
      to,
      url: httpsUrl
        .optional()
        .describe('https URL of the media (checked by the outbound URL guard).'),
      storage_path: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('Path in the Gateway media bucket.'),
      mime: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[\w.+-]+\/[\w.+-]+$/),
      caption: z.string().max(1024).optional(),
      filename: z.string().max(255).optional(),
      voice: z.boolean().optional(),
      reply_to_id: replyToId,
      client_msg_id: clientMsgId,
      account,
      wait,
      use_case: useCase,
    })
    .refine((v) => (v.url === undefined) !== (v.storage_path === undefined), {
      message: 'exactly one of url or storage_path is required',
      path: ['url'],
    }),
  send_template: z.object({
    to,
    name: z.string().min(1).max(512),
    language: z.string().min(2).max(15).default('he'),
    params: z.array(z.string().max(1024)).max(20).default([]),
    client_msg_id: clientMsgId,
    account,
    use_case: useCase,
  }),
  list_templates: z.object({
    account,
    language: z.string().max(15).optional(),
    category: z.string().max(30).optional(),
    name: z.string().max(512).optional(),
  }),
  list_chats: z.object({ account, cursor, limit: limit(50, 200) }),
  get_messages: z.object({ chat, account, cursor, limit: limit(50, 200) }),
  get_message: z.object({ message_id: id, account }),
  get_message_status: z.object({ message_id: id, account }),
  resend_message: z.object({ message_id: id, account }),
  mark_read: z.object({ chat, message_ids: z.array(id).min(1).max(100), account }),
  list_groups: z.object({ account }),
  send_group_message: z.object({
    group: z.string().regex(/^[\d-]+@g\.us$/, 'must be a group JID (…@g.us)'),
    text,
    reply_to_id: replyToId,
    client_msg_id: clientMsgId,
    account,
    wait,
    use_case: useCase,
  }),
  get_capabilities: z.object({ account }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolArgs<N extends ToolName> = z.output<(typeof TOOL_SCHEMAS)[N]>;

export const LEGACY_TOOL_NAMES = [
  'list_automations',
  'create_automation',
  'update_automation',
  'delete_automation',
  'send_message',
  'update_reply',
  'get_thread',
  'send_reminder',
  'list_reminders',
  'cancel_reminder',
  'session_status',
  'session_reconnect',
] as const satisfies readonly ToolName[];

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

/** Required scope per tool (R3.4). */
export const TOOL_SCOPES: Record<ToolName, Scope> = {
  list_automations: 'automations:read',
  create_automation: 'automations:write',
  update_automation: 'automations:write',
  delete_automation: 'automations:write',
  send_message: 'messages:send',
  update_reply: 'messages:send',
  get_thread: 'threads:read',
  send_reminder: 'reminders:send',
  list_reminders: 'reminders:send',
  cancel_reminder: 'reminders:send',
  session_status: 'sessions:read',
  session_reconnect: 'sessions:write',
  list_accounts: 'accounts:read',
  send_media: 'media:send',
  send_template: 'templates:send',
  list_templates: 'templates:send',
  list_chats: 'threads:read',
  get_messages: 'threads:read',
  get_message: 'threads:read',
  get_message_status: 'threads:read',
  resend_message: 'messages:send',
  mark_read: 'messages:send',
  list_groups: 'groups:read',
  send_group_message: 'groups:send',
  get_capabilities: 'accounts:read',
};

/**
 * Tools that cause an outbound effect on a chat. Each MUST go through the shared send
 * path (`send-path.ts`) and therefore the single `SendGate` (S13 / L2.1).
 */
export const SEND_TOOLS = [
  'send_message',
  'update_reply',
  'send_reminder',
  'send_media',
  'send_template',
  'resend_message',
  'mark_read',
  'send_group_message',
] as const satisfies readonly ToolName[];

/** Without `account`, these prefer the Cloud alias (`meta-default`) over `default`. */
export const CLOUD_FIRST_TOOLS: ReadonlySet<ToolName> = new Set([
  'send_reminder',
  'list_reminders',
  'cancel_reminder',
  'send_template',
  'list_templates',
]);

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  list_automations: 'List status-reply automations.',
  create_automation: 'Create a status-reply automation (keyword → reply, up to 10 options).',
  update_automation: 'Update fields of an automation.',
  delete_automation: 'Delete an automation.',
  send_message: 'Send a text message. Use client_msg_id for idempotency.',
  update_reply: 'Edit the text of an outbound message sent earlier.',
  get_thread: 'Recent messages of a chat (newest first).',
  send_reminder: 'Schedule a reminder (text inside the 24h window, or an approved template).',
  list_reminders: 'List reminders.',
  cancel_reminder: 'Cancel a reminder that was not sent yet.',
  session_status: 'Connection state of the account (never returns QR codes or secrets).',
  session_reconnect: 'Ask the worker to reconnect the account.',
  list_accounts: 'Accounts this key can use, with provider and capabilities.',
  send_media: 'Send an image, video, audio/voice note or document.',
  send_template: 'Send an approved Cloud API template (required outside the 24h window).',
  list_templates: 'List approved Cloud API templates.',
  list_chats: 'List chats (paged).',
  get_messages: 'Messages of a chat, paged with a cursor.',
  get_message: 'One message by id.',
  get_message_status: 'Delivery status of one message.',
  resend_message: 'Resend a failed message (same idempotency lineage).',
  mark_read: 'Mark messages in a chat as read.',
  list_groups: 'List WhatsApp groups (Baileys accounts).',
  send_group_message: 'Send a text message to a group (Baileys accounts).',
  get_capabilities: 'Capability flags of the account (what is supported).',
};

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
}

function toInputSchema(schema: z.ZodType): ToolDescriptor['inputSchema'] {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete js.$schema;
  // Lenient by design (legacy clients may send extra keys).
  delete js.additionalProperties;
  return { ...js, type: 'object' };
}

let cached: ToolDescriptor[] | null = null;

/** The `tools/list` payload (deterministic; frozen by snapshot). */
export function toolDescriptors(): ToolDescriptor[] {
  cached ??= TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: toInputSchema(TOOL_SCHEMAS[name]),
  }));
  return cached;
}
