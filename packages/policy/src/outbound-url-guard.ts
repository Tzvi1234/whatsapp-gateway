import { err, gatewayError, ok, type GatewayError, type Result } from '@htz/core';
import { isIpLiteralHost } from './ip-classify';

export interface UrlGuardOptions {
  /**
   * Host allowlist. Exact hosts (`hooks.grok.example`) or wildcard suffixes
   * (`*.grok.example`, matches any subdomain but not the apex). Empty = nothing allowed.
   */
  allowedHosts: readonly string[];
  /** Allowed TCP ports; default `[443]`. */
  allowedPorts?: readonly number[];
}

export interface ValidatedUrl {
  url: URL;
  /** Lower-case hostname without trailing dot; used for DNS, SNI and Host. */
  hostname: string;
  port: number;
}

const MAX_URL_LENGTH = 2048;

const deny = (detail: string): Result<never, GatewayError> =>
  err(gatewayError('url_not_allowed', detail));

/** Exact or `*.suffix` match (case-insensitive, trailing dot ignored). */
export function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return allowedHosts.some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/\.$/, '');
    if (!rule) return false;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // ".grok.example"
      return suffix.length > 1 && host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === rule;
  });
}

/**
 * Static checks for a user-supplied outbound URL (run on save and again on every send):
 * https only, no credentials, no IP-literal host in any disguised form, allowlisted host,
 * allowed port. DNS/IP checks happen in `guardedFetch`.
 */
export function validateOutboundUrl(
  input: string,
  opts: UrlGuardOptions,
): Result<ValidatedUrl, GatewayError> {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) {
    return deny('invalid_url');
  }
  // Inspect the raw authority before WHATWG normalisation turns `0x7f000001` into 127.0.0.1.
  const rawHost = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(input.trim())?.[1] ?? '';
  const rawHostOnly = rawHost.replace(/^.*@/, '').replace(/:\d*$/, '');

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return deny('invalid_url');
  }
  if (url.protocol !== 'https:') return deny('https_required');
  if (url.username || url.password) return deny('credentials_in_url');

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return deny('invalid_url');
  if (isIpLiteralHost(hostname) || (rawHostOnly && isIpLiteralHost(rawHostOnly))) {
    return deny('ip_literal_host');
  }
  if (!hostMatchesAllowlist(hostname, opts.allowedHosts)) return deny('host_not_allowlisted');

  const port = url.port ? Number(url.port) : 443;
  if (!(opts.allowedPorts ?? [443]).includes(port)) return deny('port_not_allowed');

  return ok({ url, hostname, port });
}
