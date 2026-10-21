import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { performLogin } from './login';
import { createFakeDb } from './testing/fake-db';
import { classifyPath, decideRoute, safeNext } from './route-policy';

const creds = { email: 'Owner@Example.test', password: 'correct horse battery' };

function db(lock: { locked: boolean; retry_after_seconds: number } | 'error') {
  return createFakeDb({
    rpc: {
      login_check_lockout: () =>
        lock === 'error' ? { error: { code: 'XX000' } } : { data: [lock] },
      login_record_attempt: () => ({ data: null }),
    },
  });
}

describe('login lockout (R5.1)', () => {
  it('R5.1 locked email+IP: Supabase is never called, nothing recorded', async () => {
    const f = db({ locked: true, retry_after_seconds: 840 });
    const signIn = vi.fn();
    const r = await performLogin(creds, { db: f.db, ip: '198.51.100.7', signIn });
    expect(r).toMatchObject({ ok: false, code: 'locked', retryAfterSeconds: 840 });
    expect(signIn).not.toHaveBeenCalled();
    expect(f.calledRpc('login_record_attempt')).toHaveLength(0);
  });

  it('R5.1 lockout check runs BEFORE Supabase, with lower-cased email and IP', async () => {
    const f = db({ locked: false, retry_after_seconds: 0 });
    const order: string[] = [];
    const signIn = vi.fn(async () => {
      order.push(`signIn:${f.rpcCalls.map((c) => c.fn).join(',')}`);
      return { ok: false, hasVerifiedTotp: false };
    });
    const r = await performLogin(creds, { db: f.db, ip: '198.51.100.7', signIn });
    expect(r).toMatchObject({ ok: false, code: 'invalid_credentials' });
    expect(order).toEqual(['signIn:login_check_lockout']);
    expect(f.calledRpc('login_check_lockout')[0]!.args).toEqual({
      p_email: 'owner@example.test',
      p_ip: '198.51.100.7',
    });
    expect(f.calledRpc('login_record_attempt')[0]!.args).toMatchObject({ p_success: false });
  });

  it('L2.3-style fail closed: lockout lookup error → Supabase never called', async () => {
    const f = db('error');
    const signIn = vi.fn();
    const r = await performLogin(creds, { db: f.db, ip: null, signIn });
    expect(r).toMatchObject({ ok: false, code: 'auth_unavailable' });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('success records the attempt and always routes to MFA (AAL2)', async () => {
    const f = db({ locked: false, retry_after_seconds: 0 });
    const r = await performLogin(creds, {
      db: f.db,
      ip: null,
      signIn: async () => ({ ok: true, hasVerifiedTotp: true }),
    });
    expect(r).toEqual({ ok: true, data: { next: 'mfa_verify' } });
    expect(f.calledRpc('login_record_attempt')[0]!.args).toMatchObject({ p_success: true });
  });

  it('turnstile configured and missing token → rejected before Supabase', async () => {
    const f = db({ locked: false, retry_after_seconds: 0 });
    const signIn = vi.fn();
    const r = await performLogin(creds, {
      db: f.db,
      ip: null,
      signIn,
      verifyTurnstile: async () => true,
    });
    expect(r).toMatchObject({ ok: false, code: 'captcha_failed' });
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe('proxy route policy (R5.2, C1)', () => {
  it('machine endpoints are never redirected', () => {
    for (const p of [
      '/api/meta/webhook',
      '/api/internal/deliver',
      '/api/internal/cloud-send',
      '/mcp',
    ]) {
      expect(classifyPath(p)).toBe('machine');
      expect(decideRoute(p, '', { authenticated: false, aal: null })).toEqual({ action: 'next' });
    }
  });

  it('R5.2 unauthenticated → /login, AAL1 → /mfa, AAL2 → page', () => {
    expect(decideRoute('/connect', '?tab=qr', { authenticated: false, aal: null })).toEqual({
      action: 'redirect',
      to: '/login?next=%2Fconnect%3Ftab%3Dqr',
    });
    expect(decideRoute('/connect', '', { authenticated: true, aal: 'aal1' })).toEqual({
      action: 'redirect',
      to: '/mfa?next=%2Fconnect',
    });
    expect(decideRoute('/connect', '', { authenticated: true, aal: 'aal2' })).toEqual({
      action: 'next',
    });
  });

  it('auth pages: /mfa needs a session; done users leave auth pages', () => {
    expect(decideRoute('/mfa', '', { authenticated: false, aal: null })).toEqual({
      action: 'redirect',
      to: '/login',
    });
    expect(decideRoute('/mfa', '', { authenticated: true, aal: 'aal1' })).toEqual({
      action: 'next',
    });
    expect(decideRoute('/login', '', { authenticated: true, aal: 'aal2' })).toEqual({
      action: 'redirect',
      to: '/',
    });
  });

  it('no open redirects through next=', () => {
    expect(safeNext('//evil.example.test')).toBe('/');
    expect(safeNext('https://evil.example.test')).toBe('/');
    expect(safeNext('/accounts/1')).toBe('/accounts/1');
  });
});
