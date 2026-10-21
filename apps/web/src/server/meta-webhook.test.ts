import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { handleMetaEvent, handleMetaVerify } = await import('./meta-webhook');
const { setEnvForTests } = await import('./env');
const { createFakeDb, testEnv } = await import('./testing/fake-db');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PHONE_ID = '123456789012345';
const APP_SECRET = 'appsecretfortests0123456789abcdef';
const VERIFY_TOKEN = 'verify-token-for-tests';
const NOW = new Date('2026-10-21T12:00:00Z');

function db() {
  return createFakeDb({
    rpc: {
      provider_credentials_read: () => ({
        data: [
          {
            phone_number_id: PHONE_ID,
            waba_id: '987654321',
            access_token: 'EAAtesttokenvalue000000000000',
            app_secret: APP_SECRET,
            verify_token: VERIFY_TOKEN,
          },
        ],
      }),
      provider_credentials_mark_webhook_verified: () => ({ data: true }),
      ingest_inbound: () => ({ data: [{ message_id: 'm', conversation_id: 'c', created: true }] }),
      apply_message_status: () => ({ data: true }),
    },
    table: (op) =>
      op.table === 'provider_credentials'
        ? { data: [{ account_id: ACCOUNT, phone_number_id: PHONE_ID }] }
        : { data: [] },
  });
}

function payload(tsSec = Math.floor(NOW.getTime() / 1000)) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_ID, display_phone_number: '972500000002' },
              contacts: [{ wa_id: '972500000003', profile: { name: 'Test' } }],
              messages: [
                {
                  id: 'wamid.TEST1',
                  from: '972500000003',
                  timestamp: String(tsSec),
                  type: 'text',
                  text: { body: 'שלום' },
                },
              ],
              statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: String(tsSec) }],
            },
          },
        ],
      },
    ],
  };
}

const sign = (raw: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;

function post(raw: string, sig: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig) headers['x-hub-signature-256'] = sig;
  return new Request('https://gateway.example.test/api/meta/webhook', {
    method: 'POST',
    headers,
    body: raw,
  });
}

beforeEach(() => setEnvForTests(testEnv()));

describe('Meta webhook GET (S2, C6, C15)', () => {
  const get = (token: string) =>
    new Request(
      `https://gateway.example.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=CHALLENGE42`,
    );

  it('S2 wrong hub.verify_token → 403 and nothing recorded', async () => {
    const f = db();
    const res = await handleMetaVerify(get('wrong-token'), f.db);
    expect(res.status).toBe(403);
    expect(f.calledRpc('provider_credentials_mark_webhook_verified')).toHaveLength(0);
  });

  it('S2/C6 saved verify token → 200 challenge, verified URL recorded from PUBLIC_BASE_URL', async () => {
    const f = db();
    const res = await handleMetaVerify(get(VERIFY_TOKEN), f.db);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('CHALLENGE42');
    expect(f.calledRpc('provider_credentials_mark_webhook_verified')[0]?.args).toEqual({
      p_account_id: ACCOUNT,
      p_url: 'https://gateway.example.test/api/meta/webhook',
    });
  });
});

describe('Meta webhook POST (S1)', () => {
  it('S1 valid signature on the exact raw body → 200, inbound ingested and status applied', async () => {
    const f = db();
    const raw = JSON.stringify(payload());
    const res = await handleMetaEvent(post(raw, sign(raw)), f.db, () => NOW);
    expect(res.status).toBe(200);
    const ing = f.calledRpc('ingest_inbound');
    expect(ing).toHaveLength(1);
    expect(ing[0]!.args).toMatchObject({
      p_account_id: ACCOUNT,
      p_provider_message_id: 'wamid.TEST1',
      p_chat_jid: '972500000003@s.whatsapp.net',
      p_kind: 'text',
      p_source: 'meta',
    });
    expect(f.calledRpc('apply_message_status')[0]!.args).toMatchObject({
      p_provider_message_id: 'wamid.OUT1',
      p_status: 'delivered',
    });
  });

  it('S1 re-serialised body (signature over different bytes) → 401, nothing ingested', async () => {
    const f = db();
    const raw = JSON.stringify(payload());
    const reserialised = JSON.stringify(JSON.parse(raw), null, 2);
    const res = await handleMetaEvent(post(reserialised, sign(raw)), f.db, () => NOW);
    expect(res.status).toBe(401);
    expect(f.calledRpc('ingest_inbound')).toHaveLength(0);
  });

  it('S1 wrong secret → 401', async () => {
    const f = db();
    const raw = JSON.stringify(payload());
    const res = await handleMetaEvent(post(raw, sign(raw, 'another-secret-0000000000')), f.db);
    expect(res.status).toBe(401);
    expect(f.calledRpc('ingest_inbound')).toHaveLength(0);
  });

  it('S1 missing header → 401 without touching the database', async () => {
    const f = db();
    const res = await handleMetaEvent(post(JSON.stringify(payload()), null), f.db);
    expect(res.status).toBe(401);
    expect(f.rpcCalls).toHaveLength(0);
    expect(f.ops).toHaveLength(0);
  });

  it('S1 entry older than 24h (replay) is not ingested', async () => {
    const f = db();
    const old = Math.floor(NOW.getTime() / 1000) - 25 * 3600;
    const raw = JSON.stringify(payload(old));
    const res = await handleMetaEvent(post(raw, sign(raw)), f.db, () => NOW);
    expect(res.status).toBe(200);
    expect(f.calledRpc('ingest_inbound')).toHaveLength(0);
    expect(f.calledRpc('apply_message_status')).toHaveLength(0);
  });

  it('S1 unknown phone_number_id → 401', async () => {
    const f = createFakeDb({ table: () => ({ data: [] }) });
    const raw = JSON.stringify(payload());
    const res = await handleMetaEvent(post(raw, sign(raw)), f.db, () => NOW);
    expect(res.status).toBe(401);
  });

  it('DB failure on ingest → 500 so Meta retries (ingest is idempotent)', async () => {
    const f = createFakeDb({
      rpc: {
        provider_credentials_read: () => ({
          data: [{ phone_number_id: PHONE_ID, app_secret: APP_SECRET }],
        }),
        ingest_inbound: () => ({ error: { code: 'XX000' } }),
      },
      table: () => ({ data: [{ account_id: ACCOUNT, phone_number_id: PHONE_ID }] }),
    });
    const raw = JSON.stringify(payload());
    const res = await handleMetaEvent(post(raw, sign(raw)), f.db, () => NOW);
    expect(res.status).toBe(500);
  });
});
