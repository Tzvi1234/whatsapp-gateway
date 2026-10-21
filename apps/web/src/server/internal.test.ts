import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '@htz/relay';
import type { HttpsRequestFn } from '@htz/policy';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
let current = fake.createFakeDb();
vi.mock('./supabase', () => ({ serviceClient: () => current.db }));

const { setEnvForTests } = await import('./env');
const { deliverRelayBatch, handleCloudSend } = await import('./internal');
const cloudSendRoute = await import('../app/api/internal/cloud-send/route');
const deliverRoute = await import('../app/api/internal/deliver/route');

const BATCH = '44444444-4444-4444-8444-444444444444';
const TARGET = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MSG = '66666666-6666-4666-8666-666666666666';
const RELAY_SECRET = 'relay-sender-key-for-tests-000000';
const SECRET = fake.testEnv().INTERNAL_API_SECRET;

function relayDb(url = 'https://hooks.grok.example.test/lia/webhook') {
  return fake.createFakeDb({
    rpc: {
      vault_read_secret: () => ({ data: RELAY_SECRET }),
      relay_batch_delivery_result: (a) => ({
        data: a.p_http_status === 200 ? 'accepted' : 'unreachable',
      }),
      relay_record_test: () => ({ data: true }),
    },
    table: (op) => {
      if (op.table === 'relay_batches') {
        return {
          data: {
            batch_id: BATCH,
            relay_target_id: TARGET,
            account_id: ACCOUNT,
            message_ids: [MSG],
            is_test: false,
            status: null,
            attempts: 0,
            created_at: '2026-10-21T12:00:00Z',
          },
        };
      }
      if (op.table === 'relay_targets') {
        return {
          data: {
            id: TARGET,
            url,
            secret_vault_id: '77777777-7777-4777-8777-777777777777',
            enabled: true,
            no_reply_threshold_min: 10,
          },
        };
      }
      if (op.table === 'messages') {
        return {
          data: [
            {
              id: MSG,
              kind: 'text',
              body: 'היי',
              sender_jid: '972500000001@s.whatsapp.net',
              received_at: '2026-10-21T12:00:00Z',
              created_at: '2026-10-21T12:00:00Z',
              media_path: null,
              transcript: null,
              quoted_provider_id: null,
              is_forwarded: false,
            },
          ],
        };
      }
      return { data: null };
    },
  });
}

/** Fake https.request capturing what would go on the wire. */
function fakeRequest(status = 200) {
  const calls: { options: Record<string, unknown>; body: string }[] = [];
  const request = ((options: Record<string, unknown>, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    let body = '';
    req.write = (b: Buffer) => {
      body += b.toString('utf8');
      return true;
    };
    req.destroy = () => undefined;
    req.end = () => {
      calls.push({ options, body });
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
      res.statusCode = status;
      res.headers = {};
      res.resume = () => undefined;
      res.destroy = () => undefined;
      cb(res);
      res.emit('end');
    };
    return req;
  }) as unknown as HttpsRequestFn;
  return { request, calls };
}

beforeEach(() => setEnvForTests(fake.testEnv()));

describe('internal endpoints: x-internal-secret', () => {
  const req = (path: string, secret?: string) =>
    new Request(`https://gateway.example.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-internal-secret': secret } : {}),
      },
      body: JSON.stringify({ kind: 'relay', id: BATCH, attempt: 0 }),
    });

  it.each([
    ['cloud-send', cloudSendRoute.POST],
    ['deliver', deliverRoute.POST],
  ] as const)(
    '%s rejects missing / wrong secret with 401 and touches nothing',
    async (name, POST) => {
      current = fake.createFakeDb();
      for (const s of [undefined, 'wrong', `${SECRET}x`]) {
        const res = await POST(req(`/api/internal/${name}`, s));
        expect(res.status).toBe(401);
      }
      expect(current.rpcCalls).toHaveLength(0);
      expect(current.ops).toHaveLength(0);
    },
  );

  it('accepts the right secret (then validates the body; no network)', async () => {
    current = fake.createFakeDb();
    const bad = new Request('https://gateway.example.test/api/internal/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
      body: JSON.stringify({ kind: 'nope' }),
    });
    expect((await deliverRoute.POST(bad)).status).toBe(400);
    const bad2 = new Request('https://gateway.example.test/api/internal/cloud-send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
      body: '{}',
    });
    expect((await cloudSendRoute.POST(bad2)).status).toBe(400);
  });
});

describe('deliver relay batch (S3, L4.7, L4.9)', () => {
  it('S3 guard on every send: host resolving to loopback is never contacted', async () => {
    const f = relayDb();
    const { request, calls } = fakeRequest();
    await deliverRelayBatch(f.db, BATCH, {
      fetchOptions: { resolver: async () => ['127.0.0.1'], request },
    });
    expect(calls).toHaveLength(0);
    const rec = f.calledRpc('relay_batch_delivery_result')[0]!.args;
    expect(rec).toMatchObject({ p_batch_id: BATCH, p_http_status: 400 });
    expect(String(rec.p_error)).toContain('url_not_allowed');
  });

  it.each([
    ['http://hooks.grok.example.test/x'],
    ['https://evil.example.test/x'],
    ['https://2130706433/x'],
  ])('S3 stored URL %s is rejected at send time', async (url) => {
    const f = relayDb(url);
    const { request, calls } = fakeRequest();
    await deliverRelayBatch(f.db, BATCH, {
      fetchOptions: { resolver: async () => ['93.184.216.34'], request },
    });
    expect(calls).toHaveLength(0);
    expect(f.calledRpc('relay_batch_delivery_result')[0]!.args.p_http_status).toBe(400);
  });

  it('L4.9 signed POST pinned to the checked IP with Idempotency-Key = batch_id', async () => {
    const f = relayDb();
    const { request, calls } = fakeRequest(200);
    const now = new Date('2026-10-21T12:00:05Z');
    const res = await deliverRelayBatch(f.db, BATCH, {
      now: () => now,
      fetchOptions: { resolver: async () => ['93.184.216.34'], request },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const { options, body } = calls[0]!;
    const headers = options.headers as Record<string, string>;
    expect(options.servername).toBe('hooks.grok.example.test');
    expect(headers['Idempotency-Key']).toBe(BATCH);
    const verified = verifyWebhookSignature(
      headers['X-Gateway-Signature'],
      body,
      [RELAY_SECRET],
      now.getTime() / 1000,
    );
    expect(verified.ok).toBe(true);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ batch_id: BATCH, is_test: false });
    expect(payload.messages[0]).toMatchObject({
      message_id: MSG,
      from: '+972500000001',
      type: 'text',
    });
    expect(f.calledRpc('relay_batch_delivery_result')[0]!.args).toMatchObject({
      p_http_status: 200,
    });
    // S7: the sender key never appears in what we return
    expect(await res.text()).not.toContain(RELAY_SECRET);
  });
});

describe('cloud-send', () => {
  const JOB = '88888888-8888-4888-8888-888888888888';
  const body = { job_id: JOB, message_id: MSG, account_id: ACCOUNT, attempt: 1, lease_until: 'x' };
  const lease = new Date(Date.now() + 30_000).toISOString();

  function db(providerId: string | null = null) {
    return fake.createFakeDb({
      rpc: {
        complete_job: () => ({ data: true }),
        fail_job: () => ({ data: 'ready' }),
      },
      table: (op) =>
        op.table === 'outbound_queue'
          ? {
              data: {
                id: JOB,
                message_id: MSG,
                account_id: ACCOUNT,
                state: 'leased',
                lease_until: lease,
                executor: 'edge',
              },
            }
          : {
              data: {
                id: MSG,
                account_id: ACCOUNT,
                kind: 'text',
                body: 'hi',
                status: 'sending',
                provider_message_id: providerId,
                conversations: { chat_jid: '972500000003@s.whatsapp.net' },
              },
            },
    });
  }

  it('sends via the provider and completes the job', async () => {
    const f = db();
    const send = vi.fn(async () => ({
      ok: true,
      providerMessageId: 'wamid.X',
      deliveryMode: 'native' as const,
    }));
    const res = await handleCloudSend(body, f.db, { provider: { send } as never });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(f.calledRpc('complete_job')[0]!.args).toMatchObject({
      p_job_id: JOB,
      p_provider_message_id: 'wamid.X',
    });
  });

  it('RL2 never sends twice: existing provider id → complete only', async () => {
    const f = db('wamid.ALREADY');
    const send = vi.fn();
    await handleCloudSend(body, f.db, { provider: { send } as never });
    expect(send).not.toHaveBeenCalled();
    expect(f.calledRpc('complete_job')).toHaveLength(1);
  });

  it('transient Graph error → fail_job transient', async () => {
    const f = db();
    const send = vi.fn(async () => ({
      ok: false,
      error: { code: 'rate_limited' as const, transient: true },
    }));
    await handleCloudSend(body, f.db, { provider: { send } as never });
    expect(f.calledRpc('fail_job')[0]!.args).toMatchObject({
      p_error_code: 'rate_limited',
      p_transient: true,
    });
  });
});
