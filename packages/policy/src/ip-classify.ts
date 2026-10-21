import ipaddr from 'ipaddr.js';

/**
 * Address classes the outbound URL guard refuses to connect to (ARCH §4.7, TEST-PLAN S3).
 * Only plain public unicast is allowed; everything else is blocked, fail closed.
 */
export type BlockedIpReason =
  | 'invalid_ip'
  | 'loopback'
  | 'private'
  | 'carrier_grade_nat'
  | 'link_local'
  | 'unspecified'
  | 'unique_local'
  | 'ipv4_mapped'
  | 'multicast'
  | 'broadcast'
  | 'reserved'
  | 'embedded_ipv4'
  | 'non_unicast';

export type IpClassification =
  | { allowed: true; canonical: string; family: 4 | 6 }
  | { allowed: false; reason: BlockedIpReason; canonical: string | null };

const RANGE_REASON: Record<string, BlockedIpReason> = {
  loopback: 'loopback',
  private: 'private',
  carrierGradeNat: 'carrier_grade_nat',
  linkLocal: 'link_local',
  unspecified: 'unspecified',
  uniqueLocal: 'unique_local',
  ipv4Mapped: 'ipv4_mapped',
  multicast: 'multicast',
  broadcast: 'broadcast',
  reserved: 'reserved',
  benchmarking: 'reserved',
  as112: 'reserved',
  as112v6: 'reserved',
  amt: 'reserved',
  orchid2: 'reserved',
  droneRemoteIdProtocolEntityTags: 'reserved',
  // IPv6 forms that embed an IPv4 address (NAT64, 6to4, Teredo, SIIT) could tunnel to a
  // private v4 target; never needed for a webhook, so block them all.
  rfc6052: 'embedded_ipv4',
  rfc6145: 'embedded_ipv4',
  '6to4': 'embedded_ipv4',
  teredo: 'embedded_ipv4',
};

/** Explicit CIDR deny-list, checked in addition to ipaddr.js range names (belt and braces). */
const DENY_CIDRS: ReadonlyArray<[string, BlockedIpReason]> = [
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'carrier_grade_nat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link_local'],
  ['172.16.0.0/12', 'private'],
  ['192.168.0.0/16', 'private'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['::ffff:0:0/96', 'ipv4_mapped'],
  ['fc00::/7', 'unique_local'],
  ['fe80::/10', 'link_local'],
  ['ff00::/8', 'multicast'],
];

const PARSED_DENY = DENY_CIDRS.map(([cidr, reason]) => ({ net: ipaddr.parseCIDR(cidr), reason }));

/**
 * Canonicalise an address string with a real IP parser and decide whether the guard may
 * connect to it. Accepts every textual form ipaddr.js understands (dotted, decimal, octal,
 * hex, short `127.1`, bracketed or zone-indexed IPv6) so disguised loopbacks are caught.
 */
export function classifyIp(input: string): IpClassification {
  let raw = input.trim();
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
  const zone = raw.indexOf('%');
  if (zone >= 0) return { allowed: false, reason: 'link_local', canonical: null };
  if (!ipaddr.isValid(raw)) return { allowed: false, reason: 'invalid_ip', canonical: null };

  const addr = ipaddr.parse(raw);
  const canonical = addr.toString();
  for (const { net, reason } of PARSED_DENY) {
    if (addr.kind() === net[0].kind() && addr.match(net)) {
      return { allowed: false, reason, canonical };
    }
  }
  const range = addr.range();
  if (range !== 'unicast') {
    return { allowed: false, reason: RANGE_REASON[range] ?? 'non_unicast', canonical };
  }
  return { allowed: true, canonical, family: addr.kind() === 'ipv4' ? 4 : 6 };
}

/**
 * True when `host` (a URL hostname) is an IP literal in any form, including the
 * numeric/octal/hex/short IPv4 encodings and bracketed IPv6.
 */
export function isIpLiteralHost(host: string): boolean {
  const h = host.trim();
  if (h.startsWith('[') || h.includes(':')) return true;
  if (ipaddr.isValid(h)) return true;
  // WHATWG treats a host whose last label is numeric (or 0x-hex) as IPv4; reject those too.
  const last = h.replace(/\.$/, '').split('.').pop() ?? '';
  return /^(?:0x[0-9a-f]*|\d+)$/i.test(last);
}
