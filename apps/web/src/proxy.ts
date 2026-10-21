import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { publicSupabaseConfig } from './server/env';
import { decideRoute, type SessionState } from './server/route-policy';

/**
 * Next 16 proxy (formerly middleware): refreshes the Supabase session cookie and enforces
 * "logged in + AAL2" for every dashboard route (R5.2). Machine endpoints are excluded by the
 * matcher and by `decideRoute` (Meta webhook, /api/internal/*, /mcp).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  let state: SessionState = { authenticated: false, aal: null };

  try {
    const { url, anonKey } = publicSupabaseConfig();
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      const level = aal.data?.currentLevel;
      state = { authenticated: true, aal: level === 'aal2' ? 'aal2' : 'aal1' };
    }
  } catch {
    // Misconfiguration or Auth outage: fail closed (treated as logged out).
    state = { authenticated: false, aal: null };
  }

  const decision = decideRoute(request.nextUrl.pathname, request.nextUrl.search, state);
  if (decision.action === 'redirect') {
    const redirect = NextResponse.redirect(new URL(decision.to, request.url));
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    redirect.headers.set('Cache-Control', 'no-store');
    return redirect;
  }
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|api/meta/webhook|api/internal/|mcp(?:/|$)).*)',
  ],
};
