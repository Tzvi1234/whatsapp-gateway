import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordingSendGate } from '@htz/policy';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
let current = fake.createFakeDb();
vi.mock('./supabase', () => ({ serviceClient: () => current.db }));

const { setEnvForTests } = await import('./env');
const { setPolicyGateForTests } = await import('./send-gate');
const { handleReminderDispatch } = await import('./reminders');
const { createMcpDeps } = await import('./mcp-deps');
const route = await import('../app/api/internal/reminders/route');

const ORG = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const REM = '33333333-3333-4333-8333-333333333333';
const MSG = '66666666-6666-4666-8666-666666666666';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT = '972500000003@s.whatsapp.net';
const NOW = new Date('2026-10-21T12:00:00Z');

interface World {
  provider?: 'meta_cloud' | 'baileys';
  state?: string;
  leaseUntil?: string | null;
  body?: string | null;
  template?: boolean;
  lastInboundAt?: string | null;
  creds?: boolean;
  priorMessage?: boolean;
  messageStatus?: string;
}

function world(w: World = {}) {
  return fake.createFakeDb({
    rpc: {
      provider_credentials_read: () => ({
        data:
          w.creds === false
            ? []
            : [
                {
                  phone_number_id: '1000001',
                  waba_id: '2000001',
                  access_token: 'EAA-test-token',
                  app_secret: 'x',
                  verify_token: 'y',
                },
              ],
      }),
      enqueue_message: () => ({
        data: [
          {
            message_id: MSG,
            status: 'queued',
            created: true,
            job_id: null,
            conversation_id: null,
            provider_message_id: null,
          },
        ],
      }),
      message_record_send_result: () => ({ data: 'sent' }),
      reminder_record_dispatch: (a) => ({
        data: a.p_unconfigured ? 'unconfigured' : a.p_message_id ? 'sent' : 'failed',
      }),
    },
    table: (op) => {
      switch (op.table) {
        case 'reminders':
          return {
            data: {
              id: REM,
              account_id: ACCOUNT,
              to_e164: '+972500000003',
              body: w.body === undefined ? 'תזכורת: פגישה מחר' : w.body,
              template_name: w.template ? 'appointment_reminder' : null,
              template_language: w.template ? 'he' : null,
              template_params: w.template ? ['מחר'] : [],
              state: w.state ?? 'sending',
              message_id: null,
              lease_until:
                w.leaseUntil === undefined
                  ? new Date(NOW.getTime() + 30_000).toISOString()
                  : w.leaseUntil,
              api_client_id: null,
            },
          };
        case 'messages':
          if (op.filters.some((f) => f[1] === 'idempotency_key')) {
            return { data: w.priorMessage ? { id: MSG } : null };
          }
          return {
            data: {
              id: MSG,
              account_id: ACCOUNT,
              direction: 'out',
              kind: 'text',
              status: w.messageStatus ?? 'sent',
              conversations: { chat_jid: CHAT },
              created_at: NOW.toISOString(),
            },
          };
        case 'accounts':
          return {
            data: {
              id: ACCOUNT,
              org_id: ORG,
              provider: w.provider ?? 'meta_cloud',
              label: 'Cloud',
              alias: 'meta-default',
              phone_e164: null,
              status: 'open',
              capabilities: {},
              use_case_policy: { allowed_use_cases: ['reminders'], may_initiate: false },
              is_test: true,
              created_at: '2026-10-21T00:00:00Z',
            },
          };
        case 'conversations':
          return {
            data: {
              id: '99999999-9999-4999-8999-999999999999',
              chat_jid: CHAT,
              type: 'direct',
              title: null,
              last_inbound_at:
                w.lastInboundAt === undefined
                  ? new Date(NOW.getTime() - 3_600_000).toISOString()
                  : w.lastInboundAt,
              last_message_at: null,
            },
          };
        default:
          return { data: null };
      }
    },
  });
}

const body = { reminder_id: REM, lease_until: 'x' };
const OUTSIDE = '2026-10-19T08:00:00Z';
let gate = createRecordingSendGate();

beforeEach(() => {
  setEnvForTests(fake.testEnv());
  gate = createRecordingSendGate();
  setPolicyGateForTests(gate);
});
afterEach(() => setPolicyGateForTests(null));

function provider() {
  return {
    send: vi.fn(async () => ({
      ok: true,
      providerMessageId: 'wamid.REM',
      deliveryMode: 'native' as const,
    })),
  };
}

describe('reminder dispatch (/api/internal/reminders)', () => {
  it('R4.1 text inside the 24h window → gated (reminders.dispatch), enqueued as reminder:<id>, sent, linked', async () => {
    const f = world();
    const p = provider();
    const res = await handleReminderDispatch(body, f.db, {
      provider: p as never,
      now: () => NOW,
    });
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'sent' });
    expect(gate.calls).toEqual([{ entryPoint: 'reminders.dispatch', allowed: true, code: null }]);
    expect(f.calledRpc('enqueue_message')[0]!.args).toMatchObject({
      p_kind: 'text',
      p_use_case: 'reminders',
      p_idempotency_key: `reminder:${REM}`,
      p_chat_jid: CHAT,
    });
    expect(p.send).toHaveBeenCalledOnce();
    expect(f.calledRpc('message_record_send_result')[0]!.args).toMatchObject({
      p_message_id: MSG,
      p_provider_message_id: 'wamid.REM',
    });
    expect(f.calledRpc('reminder_record_dispatch')[0]!.args).toEqual({
      p_reminder_id: REM,
      p_message_id: MSG,
    });
  });

  it('R4.2 outside the window without a template → failed outside_24h_window ("use send_template"), never sent', async () => {
    const f = world({ lastInboundAt: OUTSIDE });
    const p = provider();
    await handleReminderDispatch(body, f.db, { provider: p as never, now: () => NOW });
    expect(p.send).not.toHaveBeenCalled();
    expect(f.calledRpc('enqueue_message')).toHaveLength(0);
    expect(f.calledRpc('reminder_record_dispatch')[0]!.args).toEqual({
      p_reminder_id: REM,
      p_error_code: 'outside_24h_window',
      p_detail: 'use send_template',
    });
  });

  it('R4.3 outside the window with an approved template → the template is sent', async () => {
    const f = world({ lastInboundAt: OUTSIDE, template: true });
    const p = provider();
    await handleReminderDispatch(body, f.db, { provider: p as never, now: () => NOW });
    expect(gate.calls.map((c) => [c.entryPoint, c.allowed])).toEqual([
      ['reminders.dispatch', false],
      ['reminders.dispatch', true],
    ]);
    expect(f.calledRpc('enqueue_message')[0]!.args).toMatchObject({
      p_kind: 'template',
      p_template: { name: 'appointment_reminder', language: 'he', params: ['מחר'] },
    });
    expect(p.send).toHaveBeenCalledOnce();
  });

  it('R4.4 Cloud account without credentials → unconfigured, no attempt used, nothing sent', async () => {
    const f = world({ creds: false });
    const p = provider();
    const res = await handleReminderDispatch(body, f.db, { provider: p as never, now: () => NOW });
    expect(await res.json()).toMatchObject({ outcome: 'unconfigured' });
    expect(f.calledRpc('reminder_record_dispatch')[0]!.args).toEqual({
      p_reminder_id: REM,
      p_unconfigured: true,
    });
    expect(f.calledRpc('enqueue_message')).toHaveLength(0);
    expect(gate.calls).toHaveLength(0);
  });

  it('R4.1 Baileys reminders are queued for the worker (no direct send here)', async () => {
    const f = world({ provider: 'baileys' });
    const p = provider();
    await handleReminderDispatch(body, f.db, { provider: p as never, now: () => NOW });
    expect(f.calledRpc('enqueue_message')[0]!.args).toMatchObject({ p_executor: 'auto' });
    expect(p.send).not.toHaveBeenCalled();
    expect(f.calledRpc('provider_credentials_read')).toHaveLength(0);
  });

  it('R4.6 cancelled / expired lease → 409, nothing gated or sent', async () => {
    for (const w of [{ state: 'cancelled' }, { leaseUntil: '2026-10-21T11:00:00Z' }]) {
      const f = world(w);
      const res = await handleReminderDispatch(body, f.db, { now: () => NOW });
      expect(res.status).toBe(409);
      expect(f.calledRpc('enqueue_message')).toHaveLength(0);
    }
    expect(gate.calls).toHaveLength(0);
  });

  it('R4.8 crash between enqueue and record → existing reminder:<id> message is linked, never resent', async () => {
    const f = world({ priorMessage: true });
    const p = provider();
    await handleReminderDispatch(body, f.db, { provider: p as never, now: () => NOW });
    expect(p.send).not.toHaveBeenCalled();
    expect(f.calledRpc('reminder_record_dispatch')[0]!.args).toEqual({
      p_reminder_id: REM,
      p_message_id: MSG,
    });
  });

  it('S13 route requires x-internal-secret', async () => {
    current = world();
    const res = await route.POST(
      new Request('https://gateway.example.test/api/internal/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': 'wrong' },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(401);
    expect(current.rpcCalls).toHaveLength(0);
  });
});

describe('RemindersRepo (MCP send_reminder / cancel_reminder)', () => {
  const reminderRow = {
    id: REM,
    account_id: ACCOUNT,
    to_e164: '+972500000003',
    body: 'x',
    template_name: null,
    template_language: null,
    template_params: [],
    due_at: NOW.toISOString(),
    state: 'scheduled',
    error_code: null,
    created_at: NOW.toISOString(),
  };

  function repoDb(created: boolean, cancel: 'ok' | 'conflict' = 'ok') {
    return fake.createFakeDb({
      rpc: {
        reminder_create: () => ({ data: [{ reminder_id: REM, created }] }),
        reminder_cancel: () =>
          cancel === 'ok'
            ? { data: 'cancelled' }
            : { error: { code: '55000', message: 'reminder_already_sent' } },
      },
      table: (op) => {
        if (op.table === 'accounts') {
          return {
            data: {
              id: ACCOUNT,
              org_id: ORG,
              provider: 'meta_cloud',
              label: 'Cloud',
              alias: 'meta-default',
              phone_e164: null,
              status: 'open',
              capabilities: {},
              use_case_policy: { allowed_use_cases: ['reminders'], may_initiate: false },
              is_test: true,
              created_at: '2026-10-21T00:00:00Z',
            },
          };
        }
        if (op.table === 'reminders') {
          return {
            data:
              op.columns === 'state'
                ? { state: 'sent' }
                : { ...reminderRow, state: cancel === 'ok' ? 'cancelled' : 'sent' },
          };
        }
        return { data: null };
      },
    });
  }

  const req = {
    apiClientId: KEY,
    accountId: ACCOUNT,
    chat: '+972500000003',
    text: 'x',
    template: null,
    dueAt: NOW.toISOString(),
    clientMsgId: 'client-1',
    idempotencyKey: 'client-1',
  };

  it('R3.5 same client_msg_id twice → duplicate: true (idempotency column)', async () => {
    const first = repoDb(true);
    const a = await createMcpDeps({ db: first.db }).reminders.create(req);
    expect(a).toMatchObject({ ok: true, value: { duplicate: false } });
    expect(first.calledRpc('reminder_create')[0]!.args).toMatchObject({
      p_client_reminder_id: 'client-1',
      p_api_client_id: KEY,
      p_to_e164: '+972500000003',
    });
    const again = repoDb(false);
    const b = await createMcpDeps({ db: again.db }).reminders.create(req);
    expect(b).toMatchObject({ ok: true, value: { duplicate: true, reminder: { id: REM } } });
  });

  it('R4.6 cancel before send → cancelled; after send → conflict with a clear reason', async () => {
    const ok = await createMcpDeps({ db: repoDb(true, 'ok').db }).reminders.cancel(ACCOUNT, REM);
    expect(ok).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    const late = await createMcpDeps({ db: repoDb(true, 'conflict').db }).reminders.cancel(
      ACCOUNT,
      REM,
    );
    expect(late).toMatchObject({
      ok: false,
      error: { code: 'conflict', detail: 'reminder_already_sent' },
    });
  });
});
