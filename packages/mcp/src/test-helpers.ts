/** Test-only helpers (not exported from the package index). */
import type { AuthContext } from './auth';
import { createToolRuntime } from './runtime';
import { createFakeDeps, TEST_JID, type FakeDeps } from './testing';
import type { ToolName } from './tools';
import { SCOPES, type Scope } from '@htz/core';

/** Minimal valid args for every tool (legacy tools: legacy params only). */
export const VALID_ARGS: Record<ToolName, Record<string, unknown>> = {
  list_automations: {},
  create_automation: {
    name: 'a',
    keyword: 'שלום',
    reply_text: 'היי {name}',
    bind_next_status: true,
  },
  update_automation: { id: 'auto-1', enabled: false },
  delete_automation: { id: 'auto-1' },
  send_message: { to: '0559014410', text: 'hello' },
  update_reply: { message_id: 'msg-out-1', text: 'edited' },
  get_thread: { chat: '0559014410' },
  send_reminder: { to: '0559014410', text: 'reminder' },
  list_reminders: {},
  cancel_reminder: { id: 'rem-1' },
  session_status: {},
  session_reconnect: {},
  list_accounts: {},
  send_media: { to: '0559014410', url: 'https://cdn.example.test/a.jpg', mime: 'image/jpeg' },
  send_template: { to: '0559014410', name: 'appointment_reminder', params: ['10:00', 'מחר'] },
  list_templates: {},
  list_chats: {},
  get_messages: { chat: '0559014410' },
  get_message: { message_id: 'msg-out-1' },
  get_message_status: { message_id: 'msg-out-1' },
  resend_message: { message_id: 'msg-out-1' },
  mark_read: { chat: '0559014410', message_ids: ['wamid.in1'] },
  list_groups: {},
  send_group_message: { group: '120363000000000001@g.us', text: 'hi group' },
  get_capabilities: {},
};

export function authCtx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    apiClientId: 'key-1',
    name: 'test',
    scopes: new Set<Scope>(SCOPES.filter((s) => s !== 'relay')),
    accountIds: ['acc-baileys', 'acc-cloud'],
    conversationIds: null,
    legacy: false,
    ...over,
  };
}

/** Fake deps seeded so every VALID_ARGS call succeeds. */
export function seededDeps(): FakeDeps {
  const f = createFakeDeps();
  for (const accountId of ['acc-baileys', 'acc-cloud']) {
    f.messages.seed({
      id: 'msg-out-1',
      accountId,
      chat: TEST_JID,
      status: 'failed',
      errorCode: 'network',
    });
  }
  f.automations.items.push({
    id: 'auto-1',
    accountId: 'acc-baileys',
    name: 'a',
    keyword: 'k',
    match: 'contains',
    caseSensitive: false,
    ignoreEmoji: true,
    replyText: 'r',
    options: [],
    mediaUrl: null,
    statusId: null,
    bindNextStatus: true,
    enabled: true,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  });
  f.reminders.items.push({
    id: 'rem-1',
    accountId: 'acc-cloud',
    chat: TEST_JID,
    text: 'r',
    template: null,
    dueAt: '2026-10-22T00:00:00.000Z',
    state: 'scheduled',
    errorCode: null,
    createdAt: '2026-10-21T00:00:00.000Z',
  });
  return f;
}

export function runtimeFor(f: FakeDeps, auth: AuthContext = authCtx()) {
  return createToolRuntime(f.deps, auth, { ip: '203.0.113.7', requestId: 'req-1' });
}
