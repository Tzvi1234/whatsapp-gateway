import { describe, expect, it } from 'vitest';
import { hostMatchesAllowlist, validateOutboundUrl } from './outbound-url-guard';

const opts = { allowedHosts: ['hooks.grok.example', '*.lia.grok.example'] };
const code = (url: string) => {
  const r = validateOutboundUrl(url, opts);
  return r.ok ? 'ok' : r.error.detail;
};

describe('validateOutboundUrl', () => {
  it('S3 accepts an allowlisted https URL', () => {
    const r = validateOutboundUrl('https://hooks.grok.example/routine/abc?x=1', opts);
    expect(r.ok && r.value.hostname).toBe('hooks.grok.example');
  });

  it('S3 rejects http://', () => {
    expect(code('http://hooks.grok.example/x')).toBe('https_required');
  });

  it('S3 rejects a domain not on the allowlist', () => {
    expect(code('https://evil.example/x')).toBe('host_not_allowlisted');
    expect(code('https://hooks.grok.example.evil.example/x')).toBe('host_not_allowlisted');
  });

  it('S3 wildcard matches subdomains but not the apex', () => {
    expect(code('https://a.lia.grok.example/x')).toBe('ok');
    expect(code('https://a.b.lia.grok.example/x')).toBe('ok');
    expect(code('https://lia.grok.example/x')).toBe('host_not_allowlisted');
    expect(code('https://xlia.grok.example/x')).toBe('host_not_allowlisted');
  });

  it.each([
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://0x7f000001/',
    'https://127.1/',
    'https://127.0.0.1/',
    'https://[::]/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://0.0.0.0/',
    'https://169.254.169.254/latest/meta-data',
    'https://8.8.8.8/',
  ])('S3 rejects IP-literal host %s', (url) => {
    expect(code(url)).toBe('ip_literal_host');
  });

  it('S3 rejects IP literals even when the allowlist contains them', () => {
    const r = validateOutboundUrl('https://127.0.0.1/', { allowedHosts: ['127.0.0.1'] });
    expect(r.ok).toBe(false);
  });

  it('S3 rejects credentials, odd ports and junk', () => {
    expect(code('https://user:pw@hooks.grok.example/')).toBe('credentials_in_url');
    expect(code('https://hooks.grok.example:8443/')).toBe('port_not_allowed');
    expect(code('not a url')).toBe('invalid_url');
    expect(code('')).toBe('invalid_url');
    expect(code('file:///etc/passwd')).toBe('https_required');
  });

  it('S3 empty allowlist fails closed', () => {
    expect(validateOutboundUrl('https://hooks.grok.example/', { allowedHosts: [] }).ok).toBe(false);
  });

  it('returns url_not_allowed code', () => {
    const r = validateOutboundUrl('http://x', opts);
    expect(!r.ok && r.error.code).toBe('url_not_allowed');
  });
});

describe('hostMatchesAllowlist', () => {
  it('is case-insensitive and ignores a trailing dot', () => {
    expect(hostMatchesAllowlist('HOOKS.grok.example.', ['hooks.GROK.example'])).toBe(true);
  });
});
