import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { env } from './env';

/**
 * Supabase clients. The service-role client bypasses RLS and is used ONLY server-side
 * (route handlers, server actions, MCP deps) to call `security definer` RPCs; it must never
 * reach a client component. The user client carries the dashboard session (cookies) so
 * reads go through RLS (member/owner + AAL2).
 */

export type Db = SupabaseClient;

let service: Db | null = null;

export function serviceClient(): Db {
  if (!service) {
    const e = env();
    service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-client-info': 'htz-gateway-web/server' } },
    });
  }
  return service;
}

/** Per-request client bound to the dashboard user's session cookies (RLS applies). */
export async function userClient(): Promise<Db> {
  const e = env();
  const store = await cookies();
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there; the proxy refreshes them.
        }
      },
    },
  });
}

/**
 * A throwaway anon client with no session persistence. Used for re-authentication
 * (password check before dangerous actions, R5.6) without touching the user's cookies.
 */
export function ephemeralAnonClient(): Db {
  const e = env();
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
