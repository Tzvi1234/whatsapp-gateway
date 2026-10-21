import { describe, expect, it } from 'vitest';
import { classifyIp, isIpLiteralHost } from './ip-classify';

describe('classifyIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['2130706433', 'loopback'],
    ['0177.0.0.1', 'loopback'],
    ['0x7f000001', 'loopback'],
    ['127.1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'carrier_grade_nat'],
    ['100.127.255.254', 'carrier_grade_nat'],
    ['169.254.169.254', 'link_local'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['192.0.2.10', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['[::]', 'unspecified'],
    ['::ffff:127.0.0.1', 'ipv4_mapped'],
    ['::ffff:8.8.8.8', 'ipv4_mapped'],
    ['[::ffff:7f00:1]', 'ipv4_mapped'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456::1', 'unique_local'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['febf::1', 'link_local'],
    ['ff02::1', 'multicast'],
    ['64:ff9b::7f00:1', 'embedded_ipv4'],
    ['2002:7f00:1::', 'embedded_ipv4'],
    ['2001::1', 'embedded_ipv4'],
    ['2001:db8::1', 'reserved'],
  ])('S3 blocks %s (%s)', (addr, reason) => {
    const c = classifyIp(addr);
    expect(c.allowed).toBe(false);
    if (!c.allowed) expect(c.reason).toBe(reason);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111'])(
    'S3 allows public unicast %s',
    (addr) => {
      expect(classifyIp(addr).allowed).toBe(true);
    },
  );

  it('S3 rejects garbage as invalid_ip', () => {
    expect(classifyIp('not-an-ip')).toMatchObject({ allowed: false, reason: 'invalid_ip' });
    expect(classifyIp('')).toMatchObject({ allowed: false, reason: 'invalid_ip' });
  });

  it('S3 canonicalises disguised forms', () => {
    expect(classifyIp('0x7f000001')).toMatchObject({ canonical: '127.0.0.1' });
    expect(classifyIp('2130706433')).toMatchObject({ canonical: '127.0.0.1' });
  });
});

describe('isIpLiteralHost', () => {
  it.each(['127.0.0.1', '2130706433', '0x7f000001', '127.1', '[::1]', '::1', 'a.b.0x10'])(
    'S3 treats %s as an IP literal',
    (h) => expect(isIpLiteralHost(h)).toBe(true),
  );
  it.each(['hooks.grok.example', 'api-1.grok.example'])('S3 treats %s as a name', (h) =>
    expect(isIpLiteralHost(h)).toBe(false),
  );
});
