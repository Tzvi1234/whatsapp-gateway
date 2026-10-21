import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
const { setEnvForTests } = await import('./env');
const { createMcpDeps } = await import('./mcp-deps');

const ORG = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MSG = '66666666-6666-4666-8666-666666666666';
const CHAT = '972500000003@s.whatsapp.net';

function account(provider: 'baileys' | 'meta_cloud') {
  return {
    id: ACCOUNT,
    org_id: ORG,
    provider,
    label: 'Test',
    alias: 'default',
    phone_e164: null,
    status: 'open',
    capabilities: {},
    use_case_policy: { allowed_use_cases: ['customer_service'], may_initiate: false },
    is_test: true,
    created_at: '2026-10-21T00:00:00Z',
  };
}

beforeEach(() => setEnvForTests(fake.testEnv()));

describe('MessagesService.markRead', () => {
  it('R3.1 Baileys account → request_mark_read worker command with provider ids', async () => {
    const f = fake.createFakeDb({
      rpc: { request_mark_read: () => ({ data: 'cmd-1' }) },
      table: (op) => {
        if (op.table === 'accounts') return { data: account('baileys') };
        if (op.table === 'messages') {
          if (op.filters.some((x) => x[1] === 'provider_message_id')) return { data: null };
          return {
            data: {
              id: MSG,
              account_id: ACCOUNT,
              provider_message_id: 'WAIN0001',
              conversations: { chat_jid: CHAT },
            },
          };
        }
        return { data: null };
      },
    });
    const deps = createMcpDeps({ db: f.db });
    const r = await deps.messages.markRead(ACCOUNT, '+972500000003', [MSG, 'WAIN0002']);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(f.calledRpc('request_mark_read')[0]!.args).toEqual({
      p_account_id: ACCOUNT,
      p_chat: CHAT,
      p_ids: ['WAIN0001', 'WAIN0002'],
      p_via: 'mcp',
    });
  });

  it('R3.1 unknown gateway message id → not_found, nothing queued', async () => {
    const f = fake.createFakeDb({
      rpc: { request_mark_read: () => ({ data: 'cmd-1' }) },
      table: (op) => (op.table === 'accounts' ? { data: account('baileys') } : { data: null }),
    });
    const deps = createMcpDeps({ db: f.db });
    const r = await deps.messages.markRead(ACCOUNT, CHAT, [MSG]);
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(f.calledRpc('request_mark_read')).toHaveLength(0);
  });

  it('R3.1 Cloud account → Graph read receipt, no worker command', async () => {
    const f = fake.createFakeDb({
      table: (op) => (op.table === 'accounts' ? { data: account('meta_cloud') } : { data: null }),
    });
    const readReceipt = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const deps = createMcpDeps({ db: f.db, provider: { readReceipt } as never });
    const r = await deps.messages.markRead(ACCOUNT, CHAT, ['wamid.X']);
    expect(r.ok).toBe(true);
    expect(readReceipt).toHaveBeenCalledWith(ACCOUNT, 'wamid.X');
    expect(f.calledRpc('request_mark_read')).toHaveLength(0);
  });
});
