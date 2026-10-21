/**
 * Pure routing policy for the dashboard proxy (R5.2, C1). Machine endpoints authenticate
 * themselves (Meta signature, internal secret, API key) and are never redirected.
 */

export const MACHINE_PREFIXES = ['/api/meta/webhook', '/api/internal/', '/mcp'] as const;
export const AUTH_PAGES = ['/login', '/mfa'] as const;
export const OPEN_PAGES = ['/forbidden'] as const;

export type PathClass = 'machine' | 'auth_page' | 'open' | 'protected';

const matches = (pathname: string, p: string) =>
  p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`);

export function classifyPath(pathname: string): PathClass {
  if (MACHINE_PREFIXES.some((p) => matches(pathname, p))) return 'machine';
  if (AUTH_PAGES.some((p) => matches(pathname, p))) return 'auth_page';
  if (OPEN_PAGES.some((p) => matches(pathname, p))) return 'open';
  return 'protected';
}

export interface SessionState {
  authenticated: boolean;
  aal: 'aal1' | 'aal2' | null;
}

export type RouteDecision = { action: 'next' } | { action: 'redirect'; to: string };

/** Only same-origin relative paths are allowed as `next` targets (no open redirect). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

export function decideRoute(pathname: string, search: string, s: SessionState): RouteDecision {
  const cls = classifyPath(pathname);
  if (cls === 'machine' || cls === 'open') return { action: 'next' };
  const full = AUTH_PAGES.some((p) => matches(pathname, p)) ? '/' : `${pathname}${search}`;

  if (cls === 'auth_page') {
    if (pathname.startsWith('/login')) {
      return s.authenticated && s.aal === 'aal2'
        ? { action: 'redirect', to: '/' }
        : { action: 'next' };
    }
    // /mfa
    if (!s.authenticated) return { action: 'redirect', to: '/login' };
    return s.aal === 'aal2' ? { action: 'redirect', to: '/' } : { action: 'next' };
  }

  if (!s.authenticated) {
    return { action: 'redirect', to: `/login?next=${encodeURIComponent(safeNext(full))}` };
  }
  if (s.aal !== 'aal2') {
    return { action: 'redirect', to: `/mfa?next=${encodeURIComponent(safeNext(full))}` };
  }
  return { action: 'next' };
}
