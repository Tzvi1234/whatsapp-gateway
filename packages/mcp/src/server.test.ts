import { describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { generateApiKey, hashApiKey, tokenShape } from './auth';
import * as pkg from './index';
import { handleMcpRequest } from './server';
import { createFakeDeps, FIXED_NOW, type FakeDeps } from './testing';
import { LEGACY_TOOL_NAMES, TOOL_NAMES } from './tools';

function rpc(token: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  };
  if (token !== null) h.authorization = `Bearer ${token}`;
  return new Request('https://gateway.example.test/mcp', {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'grok', version: '1' },
  },
};
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const call = (name: string, args: unknown) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: args },
});

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function setup(): { f: FakeDeps; token: string } {
  const f = createFakeDeps();
  const { token } = f.apiKeys.issue();
  return { f, token };
}

describe('handleMcpRequest (stateless Streamable HTTP)', () => {
  it('R3.1 initialize, tools/list and tools/call over HTTP', async () => {
    const { f, token } = setup();
    const i = await handleMcpRequest(rpc(token, init), f.deps);
    expect(i.status).toBe(200);
    expect(i.headers.get('mcp-session-id')).toBeNull();
    expect(await json(i)).toMatchObject({ result: { serverInfo: { name: 'whatsapp-gateway' } } });

    const l = await json(await handleMcpRequest(rpc(token, list), f.deps));
    const names = (l.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(TOOL_NAMES);
    for (const n of LEGACY_TOOL_NAMES) expect(names).toContain(n);

    const c = await json(
      await handleMcpRequest(
        rpc(token, call('send_message', { to: '0559014410', text: 'hi' })),
        f.deps,
      ),
    );
    const result = c.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true, status: 'queued' });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(f.apiKeys.touched).toEqual(['key-1', 'key-1', 'key-1']);
  });

  it('accepts clients that only send Accept: application/json', async () => {
    const { f, token } = setup();
    const res = await handleMcpRequest(rpc(token, list, { accept: 'application/json' }), f.deps);
    expect(res.status).toBe(200);
  });

  it('tool errors come back in-band with the §6 shape', async () => {
    const { f, token } = setup();
    const c = await json(
      await handleMcpRequest(
        rpc(token, call('send_message', { to: 'not-a-number', text: 'hi' })),
        f.deps,
      ),
    );
    expect(c.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: 'invalid_number' },
    });
  });

  it('S8 missing, malformed, unknown, revoked and expired keys → 401 and audited', async () => {
    const f = createFakeDeps();
    const revoked = f.apiKeys.issue({ id: 'k-rev', revokedAt: '2026-10-01T00:00:00Z' }).token;
    const expired = f.apiKeys.issue({ id: 'k-exp', expiresAt: '2026-10-21T09:59:59Z' }).token;
    const good = f.apiKeys.issue({ id: 'k-ok', expiresAt: '2026-10-21T10:00:01Z' }).token;
    const unknown = generateApiKey().token;
    const wrongSecret = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    for (const [tok, detail] of [
      [null, 'missing_bearer'],
      ['gw_short', 'malformed_key'],
      [unknown, 'unknown_key'],
      [wrongSecret, 'unknown_key'],
      [revoked, 'revoked'],
      [expired, 'expired'],
    ] as const) {
      const res = await handleMcpRequest(rpc(tok, list), f.deps);
      expect(res.status, String(detail)).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
      expect(await json(res)).toMatchObject({ ok: false, code: 'unauthorized', detail });
    }
    expect(f.audit.entries.every((e) => e.action === 'mcp.auth' && e.outcome === 'rejected')).toBe(
      true,
    );
    expect(f.audit.entries).toHaveLength(6);
    expect((await handleMcpRequest(rpc(good, list), f.deps)).status).toBe(200);
  });

  it('S8 keys are stored hashed (SHA-256), plaintext never stored', () => {
    const f = createFakeDeps();
    const { token, record } = f.apiKeys.issue();
    expect(record.keyHash).toBe(hashApiKey(token));
    expect(JSON.stringify(f.apiKeys.records)).not.toContain(token.split('_')[2]);
    expect(tokenShape(token)).toEqual({ kind: 'prefixed', prefix: record.keyPrefix });
  });

  it('S8 request rate limit → 429 with Retry-After and retry_after', async () => {
    const { f, token } = setup();
    f.rateLimiter.deny.set('req:key-1', 2_500);
    const res = await handleMcpRequest(rpc(token, list), f.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await json(res)).toMatchObject({
      ok: false,
      code: 'rate_limited',
      retry_after: 3,
      action: 'retry_later',
    });
  });

  it('R3.3 an imported legacy token hash authenticates with only the URL changed', async () => {
    const f = createFakeDeps();
    const legacyToken = 'legacy-agent-token-0123456789abcdef';
    f.apiKeys.importLegacy(legacyToken);
    const res = await handleMcpRequest(rpc(legacyToken, call('session_status', {})), f.deps);
    expect(res.status).toBe(200);
    expect((await json(res)).result).toMatchObject({ isError: false });
    // a non-legacy record can never be reached through the legacy lookup
    f.apiKeys.records[0]!.legacy = false;
    expect((await handleMcpRequest(rpc(legacyToken, list), f.deps)).status).toBe(401);
  });

  it('L2.3 key lookup errors, thrown lookups, malformed rows and limiter failures fail closed', async () => {
    const { f, token } = setup();
    f.apiKeys.failWith = 'error';
    expect(
      (
        await handleMcpRequest(
          rpc(token, call('send_message', { to: '0559014410', text: 'x' })),
          f.deps,
        )
      ).status,
    ).toBe(503);
    f.apiKeys.failWith = 'throw';
    expect((await handleMcpRequest(rpc(token, list), f.deps)).status).toBe(503);
    f.apiKeys.failWith = null;
    (f.apiKeys.records[0] as { scopes: unknown }).scopes = 'messages:send';
    expect((await handleMcpRequest(rpc(token, list), f.deps)).status).toBe(401);
    (f.apiKeys.records[0] as { scopes: unknown }).scopes = ['messages:send'];
    f.rateLimiter.throws = true;
    expect((await handleMcpRequest(rpc(token, list), f.deps)).status).toBe(503);
    expect(f.sideEffects()).toBe(0);
  });

  it('L2.2 a relay-scoped key without conversation binding is rejected', async () => {
    const f = createFakeDeps();
    const { token } = f.apiKeys.issue({
      scopes: ['relay', 'messages:send'],
      conversationIds: null,
    });
    expect((await handleMcpRequest(rpc(token, list), f.deps)).status).toBe(401);
    const { token: empty } = f.apiKeys.issue({ scopes: ['messages:send'], conversationIds: [] });
    expect((await handleMcpRequest(rpc(empty, list), f.deps)).status).toBe(401);
  });

  it('R3.7 stateless HTTP only: GET/DELETE → 405 and no stdio entry point', async () => {
    const { f, token } = setup();
    const get = new Request('https://gateway.example.test/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await handleMcpRequest(get, f.deps)).status).toBe(405);
    expect(Object.keys(pkg).some((k) => /stdio/i.test(k))).toBe(false);
  });

  it('uses the injected clock for expiry', () => {
    expect(FIXED_NOW.toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });
});
