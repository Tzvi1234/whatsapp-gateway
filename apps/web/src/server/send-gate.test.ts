import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordingSendGate, type SendEntryPoint } from '@htz/policy';
import { SEND_TOOLS, type SendGateContext } from '@htz/mcp';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
const { setEnvForTests } = await import('./env');
const { checkSend, setPolicyGateForTests } = await import('./send-gate');
const { createMcpDeps } = await import('./mcp-deps');
const { dashboardResend, dashboardSend } = await import('./dashboard-send');

const ORG = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONV = '99999999-9999-4999-8999-999999999999';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = '66666666-6666-4666-8666-666666666666';
const CHAT = '972500000003@s.whatsapp.net';

interface Opts {
  accountError?: boolean;
  conversationError?: boolean;
  policy?: unknown;
}

function world(o: Opts = {}) {
  return fake.createFakeDb({
    rpc: {
      lookup_api_client: () => ({
        data: [
          {
            id: KEY,
            org_id: ORG,
            name: 'agent',
            key_hash: '0'.repeat(64),
            scopes: [
              'messages:send',
              'reminders:send',
              'media:send',
              'templates:send',
              'groups:send',
            ],
            account_ids: [ACCOUNT],
            conversation_ids: null,
            rate_limit: {},
            expires_at: null,
            legacy: false,
          },
        ],
      }),
      enqueue_message: () => ({
        data: [
          {
            message_id: MSG,
            status: 'queued',
            created: true,
            job_id: 'j',
            conversation_id: CONV,
            provider_message_id: null,
          },
        ],
      }),
      message_requeue: () => ({ data: 'job-1' }),
    },
    table: (op) => {
      if (op.table === 'accounts') {
        if (o.accountError) return { error: { code: 'XX000' } };
        return {
          data: {
            id: ACCOUNT,
            org_id: ORG,
            provider: 'baileys',
            label: 'Test',
            alias: 'default',
            phone_e164: null,
            status: 'open',
            capabilities: {},
            use_case_policy: o.policy ?? {
              allowed_use_cases: ['customer_service', 'reminders', 'agent_relay'],
              may_initiate: false,
              sender_allowlist: ['+972500000003'],
              relay: true,
            },
            is_test: true,
            created_at: '2026-10-21T00:00:00Z',
          },
        };
      }
      if (op.table === 'conversations') {
        if (o.conversationError) return { error: { code: 'XX000' } };
        return {
          data: {
            id: CONV,
            chat_jid: CHAT,
            type: 'direct',
            title: null,
            last_inbound_at: '2026-10-21T11:00:00Z',
            last_message_at: '2026-10-21T11:00:00Z',
          },
        };
      }
      if (op.table === 'messages') {
        return {
          data: {
            id: MSG,
            account_id: ACCOUNT,
            direction: 'out',
            kind: 'text',
            body: 'x',
            status: 'failed',
            use_case: 'customer_service',
            conversations: { chat_jid: CHAT },
            created_at: '2026-10-21T11:00:00Z',
          },
        };
      }
      return { data: null };
    },
  });
}

function gateCtx(tool: string, over: Partial<SendGateContext> = {}): SendGateContext {
  return {
    intent: 'send',
    tool,
    apiClientId: KEY,
    accountId: ACCOUNT,
    provider: 'baileys',
    chat: tool === 'send_group_message' ? '120363000000000001@g.us' : CHAT,
    conversationIds: null,
    kind: tool === 'send_media' ? 'media' : tool === 'send_reminder' ? 'reminder' : 'text',
    useCase: 'customer_service',
    ...over,
  };
}

let gate = createRecordingSendGate();
beforeEach(() => {
  setEnvForTests(fake.testEnv());
  gate = createRecordingSendGate();
  setPolicyGateForTests(gate);
});
afterEach(() => setPolicyGateForTests(null));

describe('S13 every web send entry point hits the single policy gate', () => {
  it('S13 MCP send tools, dashboard send/resend and relay replies are all gated', async () => {
    const f = world();
    const deps = createMcpDeps({ db: f.db });
    await deps.apiKeys.findByPrefix('abcd1234');
    for (const tool of SEND_TOOLS) {
      if (tool === 'mark_read') continue; // receipt only: binding check, not a message send
      await deps.sendGate(gateCtx(tool));
    }
    const actor = { userId: '33333333-3333-4333-8333-333333333333', orgId: ORG };
    const sent = await dashboardSend(f.db, actor, {
      accountId: ACCOUNT,
      to: '050-000-0003',
      text: 'בדיקה',
    });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const resent = await dashboardResend(f.db, actor, MSG);
    expect(resent.ok, JSON.stringify(resent)).toBe(true);

    // Relay key (Lia) replying → tagged relay.reply.
    const liaDeps = createMcpDeps({ db: relayWorld().db });
    await liaDeps.apiKeys.findByPrefix('lia00001');
    const r = await liaDeps.sendGate(gateCtx('send_message', { useCase: 'agent_relay' }));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const webEntryPoints: SendEntryPoint[] = [
      'mcp.send_message',
      'mcp.update_reply',
      'mcp.send_media',
      'mcp.send_template',
      'mcp.send_reminder',
      'mcp.send_group_message',
      'mcp.resend_message',
      'dashboard.send',
      'dashboard.resend',
      'relay.reply',
    ];
    expect(gate.ungated(webEntryPoints)).toEqual([]);
  });

  it('L2.1 relay key cannot reach a chat outside its conversations', async () => {
    const deps = createMcpDeps({ db: relayWorld({ otherConversation: true }).db });
    await deps.apiKeys.findByPrefix('lia00001');
    const r = await deps.sendGate(gateCtx('send_message', { useCase: 'agent_relay' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden_chat' } });
  });
});

describe('L2.3 fail closed', () => {
  it('L2.3 account lookup error → rejected', async () => {
    const r = await checkSend(world({ accountError: true }).db, {
      entryPoint: 'dashboard.send',
      accountId: ACCOUNT,
      chat: CHAT,
      kind: 'text',
      actor: { type: 'user', userId: 'u' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('L2.3 conversation lookup error → rejected', async () => {
    const r = await checkSend(world({ conversationError: true }).db, {
      entryPoint: 'dashboard.send',
      accountId: ACCOUNT,
      chat: CHAT,
      kind: 'text',
      actor: { type: 'user', userId: 'u' },
    });
    expect(r.ok).toBe(false);
  });

  it('L2.3 malformed policy row → rejected', async () => {
    const r = await checkSend(world({ policy: { allowed_use_cases: 'everything' } }).db, {
      entryPoint: 'dashboard.send',
      accountId: ACCOUNT,
      chat: CHAT,
      kind: 'text',
      actor: { type: 'user', userId: 'u' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'use_case_not_allowed' } });
  });

  it('L2.3 MCP gate without an authenticated key context → rejected', async () => {
    const deps = createMcpDeps({ db: world().db });
    const r = await deps.sendGate(gateCtx('send_message'));
    expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('L2.3 thrown DB error → rejected, never allowed', async () => {
    const f = fake.createFakeDb({
      table: () => {
        throw new Error('db down');
      },
    });
    const r = await checkSend(f.db, {
      entryPoint: 'dashboard.send',
      accountId: ACCOUNT,
      chat: CHAT,
      kind: 'text',
      actor: { type: 'user', userId: 'u' },
    });
    expect(r.ok).toBe(false);
  });

  it('R2.6 may_initiate=false: no prior inbound → use_case_not_allowed', async () => {
    const f = fake.createFakeDb({
      table: (op) =>
        op.table === 'accounts'
          ? {
              data: {
                id: ACCOUNT,
                org_id: ORG,
                provider: 'baileys',
                capabilities: {},
                use_case_policy: { allowed_use_cases: ['customer_service'], may_initiate: false },
              },
            }
          : { data: null },
    });
    const r = await checkSend(f.db, {
      entryPoint: 'dashboard.send',
      accountId: ACCOUNT,
      chat: '050-000-0009',
      kind: 'text',
      actor: { type: 'user', userId: 'u' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'use_case_not_allowed' } });
  });
});

function relayWorld(o: { otherConversation?: boolean } = {}) {
  return fake.createFakeDb({
    rpc: {
      lookup_api_client: () => ({
        data: [
          {
            id: KEY,
            org_id: ORG,
            name: 'lia',
            key_hash: '0'.repeat(64),
            scopes: ['relay', 'messages:send'],
            account_ids: [ACCOUNT],
            conversation_ids: [o.otherConversation ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : CONV],
            rate_limit: {},
            expires_at: null,
            legacy: false,
          },
        ],
      }),
    },
    table: (op) =>
      op.table === 'accounts'
        ? {
            data: {
              id: ACCOUNT,
              org_id: ORG,
              provider: 'baileys',
              capabilities: {},
              use_case_policy: {
                allowed_use_cases: ['agent_relay'],
                may_initiate: false,
                sender_allowlist: ['+972500000003'],
                relay: true,
              },
            },
          }
        : op.table === 'conversations'
          ? {
              data: {
                id: CONV,
                chat_jid: CHAT,
                type: 'direct',
                last_inbound_at: '2026-10-21T11:00:00Z',
              },
            }
          : { data: null },
  });
}
