// Shared runtime helpers for the Gateway Edge Functions (Deno). No third-party imports.
//
// Env (Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY automatically):
//   EDGE_CRON_SECRET     must equal the Vault secret `edge_cron_secret` sent by pg_cron as x-cron-secret
//   PUBLIC_BASE_URL      Vercel app base URL (https, no trailing slash) for /api/internal/*
//   INTERNAL_API_SECRET  shared secret sent to Vercel as x-internal-secret

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v === '' ? undefined : v;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Only pg_cron (via pg_net, with the Vault secret) may invoke these functions. */
export function isAuthorizedCron(req: Request): boolean {
  const expected = env('EDGE_CRON_SECRET');
  const got = req.headers.get('x-cron-secret');
  return expected !== undefined && got !== null && timingSafeEqual(got, expected);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Call a Postgres RPC through PostgREST as service_role. */
export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const url = `${requireEnv('SUPABASE_URL')}/rest/v1/rpc/${name}`;
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return (text === '' ? null : JSON.parse(text)) as T;
}

/** POST to the Vercel app's internal API (the Graph call / HMAC signing live there). */
export async function postInternal(
  path: string,
  body: unknown,
  timeoutMs = 25_000,
): Promise<Response> {
  const base = requireEnv('PUBLIC_BASE_URL').replace(/\/+$/, '');
  return await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': requireEnv('INTERNAL_API_SECRET'),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Run tasks with a small concurrency cap. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
