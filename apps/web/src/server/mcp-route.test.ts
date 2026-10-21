import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '@htz/mcp';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
let current = fake.createFakeDb();
vi.mock('./supabase', () => ({ serviceClient: () => current.db }));

const { setEnvForTests } = await import('./env');
const route = await import('../app/mcp/route');

const ORG = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = `gw_abcd1234_${'A'.repeat(43)}`;
const HASH = hashApiKey(TOKEN);

function world(opts: { lookupFails?: boolean; limited?: boolean } = {}) {
  return fake.createFakeDb({
    rpc: {
      lookup_api_client: () =>
        opts.lookupFails
          ? { error: { code: 'XX000' } }
          : {
              data: [
                {
                  id: KEY_ID,
                  org_id: ORG,
                  name: 'grok',
                  key_hash: HASH,
                  scopes: ['sessions:read', 'messages:send'],
                  account_ids: [ACCOUNT],
                  conversation_ids: null,
                  rate_limit: { requests_per_min: 60, sends_per_min: 20 },
                  expires_at: null,
                  legacy: false,
                },
              ],
            },
      rate_limit_take: () => ({
        data: [
          opts.limited
            ? { allowed: false, retry_after_ms: 1500, remaining: 0 }
            : { allowed: true, retry_after_ms: 0, remaining: 59 },
        ],
      }),
      api_client_touch: () => ({ data: null }),
      audit_append: () => ({ data: 'audit-id' }),
    },
    table: (op) => {
      if (op.table === 'orgs') return { data: { id: ORG } };
      if (op.table === 'accounts') {
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
            use_case_policy: { allowed_use_cases: ['customer_service'] },
            is_test: true,
            created_at: '2026-10-21T00:00:00Z',
          },
        };
      }
      if (op.table === 'sessions') {
        // Even if a row carried extra internals, only whitelisted fields leave (R3.8).
        return {
          data: {
            connection: 'open',
            connected_at: '2026-10-21T10:00:00Z',
            last_heartbeat_at: '2026-10-21T11:59:00Z',
            last_error_code: null,
            qr: 'SHOULD-NEVER-LEAK',
          },
        };
      }
      return { data: null };
    },
  });
}

const rpcBody = (name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

function post(body: string, token: string | null = TOKEN) {
  return new Request('https://gateway.example.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

beforeEach(() => setEnvForTests(fake.testEnv()));

describe('/mcp route', () => {
  it('GET and DELETE → 405', async () => {
    expect((await route.GET()).status).toBe(405);
    expect((await route.DELETE()).status).toBe(405);
  });

  it('R3.8/S7 session_status works end-to-end and leaks no QR, key hash or token', async () => {
    current = world();
    const res = await route.POST(post(rpcBody('session_status')));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('"connection":"open"');
    for (const secret of ['SHOULD-NEVER-LEAK', HASH, TOKEN]) expect(text).not.toContain(secret);
    expect(current.calledRpc('audit_append').length).toBeGreaterThan(0);
    const audit = JSON.stringify(current.calledRpc('audit_append'));
    expect(audit).not.toContain(TOKEN);
  });

  it('S8 unknown/wrong key → 401 and audited', async () => {
    current = world();
    const res = await route.POST(post(rpcBody('session_status'), `gw_abcd1234_${'B'.repeat(43)}`));
    expect(res.status).toBe(401);
    expect(current.calledRpc('audit_append')).toHaveLength(1);
  });

  it('L2.3 key lookup error → 503 (fail closed)', async () => {
    current = world({ lookupFails: true });
    const res = await route.POST(post(rpcBody('session_status')));
    expect(res.status).toBe(503);
  });

  it('S8 rate limited → 429 with Retry-After', async () => {
    current = world({ limited: true });
    const res = await route.POST(post(rpcBody('session_status')));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
  });
});
