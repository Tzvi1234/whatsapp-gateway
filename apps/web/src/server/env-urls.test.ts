import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { EnvError, parseEnv, setEnvForTests } = await import('./env');
const { metaWebhookUrl, normalizeUrlForCompare, webhookUrlChanged } = await import('./urls');
const { testEnv } = await import('./testing/fake-db');

const base = {
  PUBLIC_BASE_URL: 'https://gateway.example.test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.example.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-tests-0000000000',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests-000000',
  INTERNAL_API_SECRET: 'internal-secret-for-tests-0123456789abcdef',
};

afterEach(() => setEnvForTests(null));

describe('env', () => {
  it('parses a valid env and fails closed on empty host allowlists', () => {
    const e = parseEnv(base);
    expect(e.PUBLIC_BASE_URL).toBe('https://gateway.example.test');
    expect(e.RELAY_ALLOWED_HOSTS).toEqual([]);
    expect(e.webhookAllowedHosts).toEqual([]);
    expect(e.TURNSTILE_SECRET).toBeNull();
  });

  it.each([
    ['http://gateway.example.test'],
    ['https://gateway.example.test/'],
    ['https://gateway.example.test?x=1'],
    ['not a url'],
  ])('PUBLIC_BASE_URL %s is rejected (https only, no trailing slash)', (url) => {
    expect(() => parseEnv({ ...base, PUBLIC_BASE_URL: url })).toThrow(EnvError);
  });

  it('S7 errors name the variable but never echo values', () => {
    try {
      parseEnv({ ...base, SUPABASE_SERVICE_ROLE_KEY: 'short-secret-x' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(String(e)).not.toContain('short-secret-x');
    }
  });

  it('C8 allowlist seed is normalised to E.164 from env', () => {
    const e = parseEnv({ ...base, LIA_ALLOWLIST_SEED: '050-000-0001, +972 50 000 0001' });
    expect(e.LIA_ALLOWLIST_SEED).toEqual(['+972500000001']);
    expect(() => parseEnv({ ...base, LIA_ALLOWLIST_SEED: 'garbage' })).toThrow(EnvError);
  });

  it('WEBHOOK_ALLOWED_HOSTS defaults to RELAY_ALLOWED_HOSTS', () => {
    const e = parseEnv({ ...base, RELAY_ALLOWED_HOSTS: 'a.example.test,*.b.example.test' });
    expect(e.webhookAllowedHosts).toEqual(['a.example.test', '*.b.example.test']);
  });
});

describe('urls', () => {
  it('C6 metaWebhookUrl is built only from PUBLIC_BASE_URL', () => {
    setEnvForTests(testEnv({ PUBLIC_BASE_URL: 'https://preview-123.example.test' }));
    expect(metaWebhookUrl()).toBe('https://preview-123.example.test/api/meta/webhook');
  });

  it('C15 never shown before any verification', () => {
    expect(webhookUrlChanged(null, 'https://a.example.test/api/meta/webhook')).toBe(false);
    expect(webhookUrlChanged('', 'https://a.example.test/api/meta/webhook')).toBe(false);
  });

  it('C15 hidden when equal after normalisation (trailing slash, host case, default port)', () => {
    const cur = 'https://gateway.example.test/api/meta/webhook';
    expect(webhookUrlChanged('https://Gateway.EXAMPLE.test/api/meta/webhook/', cur)).toBe(false);
    expect(webhookUrlChanged('https://gateway.example.test:443/api/meta/webhook', cur)).toBe(false);
    expect(normalizeUrlForCompare('HTTPS://X.example.test/a//')).toBe('https://x.example.test/a');
  });

  it('C15 shown when host or path differs', () => {
    const cur = 'https://gateway.example.test/api/meta/webhook';
    expect(webhookUrlChanged('https://old.example.test/api/meta/webhook', cur)).toBe(true);
    expect(webhookUrlChanged('https://gateway.example.test/api/meta/hook', cur)).toBe(true);
  });

  it('C15 disappears after re-verify with the current URL', () => {
    setEnvForTests(testEnv());
    expect(webhookUrlChanged(metaWebhookUrl())).toBe(false);
  });
});
