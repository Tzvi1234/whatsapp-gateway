import { describe, expect, it } from 'vitest';
import { ConfigError, checkWorkerJwt, loadConfig, parseAllowlistSeed } from './config';

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const base = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_WORKER_JWT: jwt({ role: 'gateway_worker', sub: 'w1' }),
  WORKER_ID: 'htz-home-01',
  ORG_ID: '00000000-0000-4000-8000-000000000001',
  CREDENTIALS_DIRECTORY: '/run/credentials/gateway-worker.service',
  XDG_RUNTIME_DIR: '/run/user/1000',
};

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe('config', () => {
  it('parses a valid environment with safe defaults', () => {
    const c = loadConfig(base);
    expect(c.workerId).toBe('htz-home-01');
    expect(c.apiKey).toBe(base.SUPABASE_WORKER_JWT);
    expect(c.transcriber.socketPath).toBe('/run/user/1000/gateway-transcriber.sock');
    expect(c.soniox).toBeNull();
    expect(c.storageBucket).toBe('media');
    expect(c.pollIntervalMs).toBeGreaterThanOrEqual(30_000);
    expect(c.pollIntervalMs).toBeLessThanOrEqual(60_000);
  });

  it('refuses to start with the service_role key (ARCH §7.2)', () => {
    const issues = issuesOf({ ...base, SUPABASE_WORKER_JWT: jwt({ role: 'service_role' }) });
    expect(issues.join()).toMatch(/service_role key refused/);
  });

  it('refuses a JWT with any role other than gateway_worker, or a service-role apikey', () => {
    expect(
      issuesOf({ ...base, SUPABASE_WORKER_JWT: jwt({ role: 'authenticated' }) }).join(),
    ).toMatch(/role claim/);
    expect(issuesOf({ ...base, SUPABASE_WORKER_JWT: 'not-a-jwt-at-all-xxxxxxxx' }).join()).toMatch(
      /not a JWT/,
    );
    expect(
      checkWorkerJwt(base.SUPABASE_WORKER_JWT, jwt({ role: 'service_role' }), Date.now()).join(),
    ).toMatch(/SUPABASE_ANON_KEY/);
    expect(
      checkWorkerJwt(jwt({ role: 'gateway_worker', exp: 1 }), undefined, Date.now()).join(),
    ).toMatch(/expired/);
  });

  it('error messages never echo secret values', () => {
    const secret = jwt({ role: 'service_role', secret: 'TOPSECRET' });
    const issues = issuesOf({ ...base, SUPABASE_WORKER_JWT: secret });
    expect(issues.join()).not.toContain(secret);
    expect(issues.join()).not.toContain('TOPSECRET');
  });

  it('C8 LIA_ALLOWLIST_SEED normalises local numbers to E.164 and rejects garbage', () => {
    expect(parseAllowlistSeed('0559014410, +972 50 000 0001').numbers).toEqual([
      '+972559014410',
      '+972500000001',
    ]);
    expect(loadConfig({ ...base, LIA_ALLOWLIST_SEED: '055-901-4410' }).liaAllowlistSeed).toEqual([
      '+972559014410',
    ]);
    expect(issuesOf({ ...base, LIA_ALLOWLIST_SEED: 'abc' }).join()).toMatch(/LIA_ALLOWLIST_SEED/);
  });

  it('requires a session key location and bounds the poll interval to 30-60 s', () => {
    const { CREDENTIALS_DIRECTORY: _c, ...noKey } = base;
    expect(issuesOf(noKey).join()).toMatch(/session key/);
    expect(issuesOf({ ...base, POLL_INTERVAL_MS: '5000' }).join()).toMatch(/POLL_INTERVAL_MS/);
    expect(issuesOf({ ...base, POLL_INTERVAL_MS: '90000' }).join()).toMatch(/POLL_INTERVAL_MS/);
  });

  it('L3.8 Soniox is enabled only with the flag AND a key', () => {
    expect(loadConfig({ ...base, SONIOX_API_KEY: 'k' }).soniox).toBeNull();
    const flagNoKey = loadConfig({ ...base, SONIOX_ENABLED: 'true' });
    expect(flagNoKey.soniox).toBeNull();
    expect(flagNoKey.sonioxMisconfigured).toBe(true);
    expect(loadConfig({ ...base, SONIOX_ENABLED: 'true', SONIOX_API_KEY: 'k' }).soniox).toEqual({
      apiKey: 'k',
    });
  });

  it('rejects plain http except for localhost', () => {
    expect(issuesOf({ ...base, SUPABASE_URL: 'http://example.com' }).join()).toMatch(
      /SUPABASE_URL/,
    );
    expect(issuesOf({ ...base, SUPABASE_URL: '' }).join()).toMatch(/SUPABASE_URL/);
    expect(issuesOf({}).length).toBeGreaterThan(3);
    expect(loadConfig({ ...base, SUPABASE_URL: 'http://127.0.0.1:54321/' }).supabaseUrl).toBe(
      'http://127.0.0.1:54321',
    );
  });
});
