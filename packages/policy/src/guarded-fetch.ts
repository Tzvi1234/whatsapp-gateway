import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { err, gatewayError, ok, type GatewayError, type Result } from '@htz/core';
import { classifyIp } from './ip-classify';
import { validateOutboundUrl, type UrlGuardOptions } from './outbound-url-guard';

/** Resolves a hostname to every address it currently points at (A + AAAA). */
export type Resolver = (hostname: string) => Promise<readonly string[]>;

/** Minimal subset of `https.request` the guard needs; injectable for tests. */
export type HttpsRequestFn = (
  options: https.RequestOptions,
  callback: (res: IncomingMessage) => void,
) => import('node:http').ClientRequest;

export interface GuardedFetchOptions extends UrlGuardOptions {
  resolver?: Resolver;
  /** Connect (TCP+TLS) timeout. Default 5s. */
  connectTimeoutMs?: number;
  /** Total request timeout. Default 10s. */
  timeoutMs?: number;
  /** Response body cap. Default 64 KB. */
  maxBodyBytes?: number;
  /** Test seam; defaults to `node:https` `request`. */
  request?: HttpsRequestFn;
}

export interface GuardedFetchInit {
  method?: 'POST' | 'GET' | 'PUT';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The checked IP the connection was pinned to. */
  pinnedAddress: string;
}

export const DEFAULT_MAX_BODY_BYTES = 65_536;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;

export const defaultResolver: Resolver = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/**
 * Resolve, check every address, and return the one to pin to. Fails closed when any
 * resolved address is blocked (a mixed public/private answer is a rebinding signal).
 */
export async function resolveAndCheck(
  hostname: string,
  resolver: Resolver,
): Promise<Result<{ address: string; family: 4 | 6 }, GatewayError>> {
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return err(gatewayError('network', 'dns_resolution_failed'));
  }
  if (addresses.length === 0) return err(gatewayError('network', 'dns_no_addresses'));
  let pinned: { address: string; family: 4 | 6 } | null = null;
  for (const a of addresses) {
    const c = classifyIp(a);
    if (!c.allowed) return err(gatewayError('url_not_allowed', `resolved_${c.reason}`));
    pinned ??= { address: c.canonical, family: c.family };
  }
  return pinned ? ok(pinned) : err(gatewayError('network', 'dns_no_addresses'));
}

/** A `lookup` that ignores the hostname and always answers with the pre-checked IP. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      e: NodeJS.ErrnoException | null,
      a: string | { address: string; family: number }[],
      f?: number,
    ) => void;
    if (typeof options === 'object' && options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as LookupFunction;
}

/**
 * SSRF-safe HTTPS request (ARCH §4.7, TEST-PLAN S3). Runs the full guard on EVERY call:
 * static URL checks, fresh DNS resolution (so a rebinding after save is caught), IP
 * classification, then connects to the pinned IP with the original hostname for SNI and
 * Host. Redirects are never followed (3xx = error); connect/total timeouts and a body cap apply.
 * Non-2xx statuses are returned as `ok` so callers can classify them.
 */
export async function guardedFetch(
  url: string,
  init: GuardedFetchInit,
  opts: GuardedFetchOptions,
): Promise<Result<GuardedResponse, GatewayError>> {
  const v = validateOutboundUrl(url, opts);
  if (!v.ok) return v;
  const { hostname, port } = v.value;
  const target = v.value.url;

  const pin = await resolveAndCheck(hostname, opts.resolver ?? defaultResolver);
  if (!pin.ok) return pin;
  const { address, family } = pin.value;

  const request = opts.request ?? (https.request as HttpsRequestFn);
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = opts.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const body = init.body === undefined ? undefined : Buffer.from(init.body);

  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'host') delete headers[k];
  headers['Host'] = port === 443 ? hostname : `${hostname}:${port}`;
  if (body) headers['Content-Length'] = String(body.length);

  return new Promise((resolve) => {
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (r: Result<GuardedResponse, GatewayError>) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(r);
    };

    const req = request(
      {
        protocol: 'https:',
        host: hostname,
        hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'POST',
        headers,
        servername: hostname,
        lookup: pinnedLookup(address, family),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          finish(err(gatewayError('url_not_allowed', 'redirect_not_followed')));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBody) {
            req.destroy();
            res.destroy();
            finish(err(gatewayError('network', 'response_body_too_large', { transient: false })));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(
            ok({
              status,
              headers: res.headers,
              body: Buffer.concat(chunks),
              pinnedAddress: address,
            }),
          ),
        );
        res.on('error', () => finish(err(gatewayError('network', 'response_stream_error'))));
      },
    );

    timers.push(
      setTimeout(() => {
        req.destroy();
        finish(err(gatewayError('timeout', 'total_timeout')));
      }, totalTimeoutMs),
    );
    const connectTimer = setTimeout(() => {
      req.destroy();
      finish(err(gatewayError('timeout', 'connect_timeout')));
    }, connectTimeoutMs);
    timers.push(connectTimer);
    req.on('socket', (socket) => {
      const clear = () => clearTimeout(connectTimer);
      socket.once('secureConnect', clear);
      if (!(socket as { connecting?: boolean }).connecting) clear();
    });
    req.on('error', () => finish(err(gatewayError('network', 'request_failed'))));

    if (body) req.write(body);
    req.end();
  });
}
