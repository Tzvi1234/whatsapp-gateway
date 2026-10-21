import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  guardedFetch,
  pinnedLookup,
  resolveAndCheck,
  type GuardedFetchOptions,
  type HttpsRequestFn,
  type Resolver,
} from './guarded-fetch';

const PUBLIC_IP = '93.184.215.14';
const URL_OK = 'https://hooks.grok.example/routine/abc';

type Behaviour =
  | { kind: 'respond'; status: number; chunks?: Buffer[]; headers?: Record<string, string> }
  | { kind: 'hang'; connected: boolean }
  | { kind: 'error' };

function fakeTransport(behaviour: Behaviour) {
  const seen: RequestOptions[] = [];
  const written: Buffer[] = [];
  const request: HttpsRequestFn = (options, callback) => {
    seen.push(options);
    const req = new EventEmitter() as EventEmitter & {
      write: (b: Buffer) => void;
      end: () => void;
      destroy: () => void;
      destroyed: boolean;
    };
    req.destroyed = false;
    req.write = (b) => written.push(Buffer.from(b));
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = () => {
      setImmediate(() => {
        if (behaviour.kind === 'error') {
          req.emit('error', new Error('ECONNREFUSED'));
          return;
        }
        if (behaviour.kind === 'hang') {
          if (behaviour.connected) req.emit('socket', new EventEmitter());
          else req.emit('socket', Object.assign(new EventEmitter(), { connecting: true }));
          return;
        }
        req.emit('socket', new EventEmitter());
        const res = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = behaviour.status;
        res.headers = behaviour.headers ?? {};
        callback(res as unknown as IncomingMessage);
        for (const c of behaviour.chunks ?? []) {
          if (req.destroyed) return;
          res.write(c);
        }
        res.end();
      });
    };
    return req as unknown as ClientRequest;
  };
  return { request, seen, written };
}

const staticResolver =
  (...ips: string[]): Resolver =>
  async () =>
    ips;

const baseOpts = (over: Partial<GuardedFetchOptions> = {}): GuardedFetchOptions => ({
  allowedHosts: ['hooks.grok.example'],
  resolver: staticResolver(PUBLIC_IP),
  ...over,
});

describe('resolveAndCheck', () => {
  it.each(['127.0.0.1', '::1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254'])(
    'S3 rejects a host resolving to %s',
    async (ip) => {
      const r = await resolveAndCheck('hooks.grok.example', staticResolver(ip));
      expect(!r.ok && r.error.code).toBe('url_not_allowed');
    },
  );
  it.each(['fe80::1', 'fc00::1', '100.64.1.1', '::ffff:127.0.0.1', '0.0.0.0'])(
    'S3 rejects a host resolving to %s',
    async (ip) => {
      const r = await resolveAndCheck('hooks.grok.example', staticResolver(ip));
      expect(r.ok).toBe(false);
    },
  );
  it('S3 rejects a mixed public/private answer', async () => {
    const r = await resolveAndCheck('h', staticResolver(PUBLIC_IP, '10.0.0.1'));
    expect(r.ok).toBe(false);
  });
  it('S3 maps DNS failure and empty answers to network errors', async () => {
    const boom: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await resolveAndCheck('h', boom)).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
    expect(await resolveAndCheck('h', staticResolver())).toMatchObject({ ok: false });
  });
});

describe('pinnedLookup', () => {
  it('S3 always answers with the checked IP whatever hostname is asked', () => {
    const lookup = pinnedLookup(PUBLIC_IP, 4);
    const single: unknown[] = [];
    lookup('rebound.example', {}, (...args: unknown[]) => single.push(...args));
    expect(single).toEqual([null, PUBLIC_IP, 4]);
    const all: unknown[] = [];
    lookup('rebound.example', { all: true }, (...args: unknown[]) => all.push(...args));
    expect(all).toEqual([null, [{ address: PUBLIC_IP, family: 4 }]]);
  });
});

describe('guardedFetch', () => {
  it('S3 pins the connection to the checked IP with original SNI and Host', async () => {
    const t = fakeTransport({ kind: 'respond', status: 200, chunks: [Buffer.from('ok')] });
    const r = await guardedFetch(
      URL_OK,
      { headers: { 'Content-Type': 'application/json', host: 'evil.example' }, body: '{}' },
      baseOpts({ request: t.request }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe(200);
      expect(r.value.body.toString()).toBe('ok');
      expect(r.value.pinnedAddress).toBe(PUBLIC_IP);
    }
    const o = t.seen[0]!;
    expect(o.servername).toBe('hooks.grok.example');
    expect(o.headers).toMatchObject({ Host: 'hooks.grok.example', 'Content-Length': '2' });
    expect(Object.keys(o.headers ?? {}).filter((k) => k.toLowerCase() === 'host')).toEqual([
      'Host',
    ]);
    expect(o.path).toBe('/routine/abc');
    expect(o.agent).toBe(false);
    const got: unknown[] = [];
    o.lookup!('hooks.grok.example', {}, (...a: unknown[]) => got.push(...a));
    expect(got[1]).toBe(PUBLIC_IP);
    expect(Buffer.concat(t.written).toString()).toBe('{}');
  });

  it('S3 runs the static guard on every send (http rejected before any I/O)', async () => {
    const t = fakeTransport({ kind: 'respond', status: 200 });
    const r = await guardedFetch(
      'http://hooks.grok.example/x',
      {},
      baseOpts({ request: t.request }),
    );
    expect(!r.ok && r.error.code).toBe('url_not_allowed');
    expect(t.seen).toHaveLength(0);
  });

  it('S3 DNS rebinding: first lookup public, second private → second send rejected', async () => {
    const answers = [[PUBLIC_IP], ['127.0.0.1']];
    let i = 0;
    const resolver: Resolver = async () => answers[i++]!;
    const t = fakeTransport({ kind: 'respond', status: 200 });
    const first = await guardedFetch(URL_OK, {}, baseOpts({ resolver, request: t.request }));
    const second = await guardedFetch(URL_OK, {}, baseOpts({ resolver, request: t.request }));
    expect(first.ok).toBe(true);
    expect(!second.ok && second.error.detail).toBe('resolved_loopback');
    expect(t.seen).toHaveLength(1);
  });

  it('S3 never follows a 302 redirect to an internal address', async () => {
    const t = fakeTransport({
      kind: 'respond',
      status: 302,
      headers: { location: 'http://169.254.169.254/' },
    });
    const r = await guardedFetch(URL_OK, {}, baseOpts({ request: t.request }));
    expect(!r.ok && r.error.detail).toBe('redirect_not_followed');
    expect(t.seen).toHaveLength(1);
  });

  it('S3 caps the response body at 64KB', async () => {
    const big = Buffer.alloc(40_000, 1);
    const t = fakeTransport({ kind: 'respond', status: 200, chunks: [big, big] });
    const r = await guardedFetch(URL_OK, {}, baseOpts({ request: t.request }));
    expect(!r.ok && r.error.detail).toBe('response_body_too_large');
  });

  it('S3 a body exactly at the cap is accepted', async () => {
    const t = fakeTransport({ kind: 'respond', status: 200, chunks: [Buffer.alloc(65_536)] });
    const r = await guardedFetch(URL_OK, {}, baseOpts({ request: t.request }));
    expect(r.ok && r.value.body.length).toBe(65_536);
  });

  it('S3 connect timeout', async () => {
    const t = fakeTransport({ kind: 'hang', connected: false });
    const r = await guardedFetch(
      URL_OK,
      {},
      baseOpts({ request: t.request, connectTimeoutMs: 20, timeoutMs: 1_000 }),
    );
    expect(!r.ok && r.error).toMatchObject({ code: 'timeout', detail: 'connect_timeout' });
  });

  it('S3 slow response hits the total timeout', async () => {
    const t = fakeTransport({ kind: 'hang', connected: true });
    const r = await guardedFetch(
      URL_OK,
      {},
      baseOpts({ request: t.request, connectTimeoutMs: 1_000, timeoutMs: 30 }),
    );
    expect(!r.ok && r.error).toMatchObject({ code: 'timeout', detail: 'total_timeout' });
  });

  it('returns non-2xx as ok for the caller to classify; network errors as network', async () => {
    const t5 = fakeTransport({ kind: 'respond', status: 503 });
    const r5 = await guardedFetch(URL_OK, {}, baseOpts({ request: t5.request }));
    expect(r5.ok && r5.value.status).toBe(503);
    const te = fakeTransport({ kind: 'error' });
    const re = await guardedFetch(URL_OK, {}, baseOpts({ request: te.request }));
    expect(!re.ok && re.error.code).toBe('network');
  });
});
