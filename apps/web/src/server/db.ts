import { err, gatewayError, ok, type GatewayError, type Result } from '@htz/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logError } from './log';

/**
 * Thin, typed access helpers over supabase-js. Every RPC/query error becomes a
 * `GatewayError` (never thrown, never echoing row data), so callers can fail closed.
 */

type PgError = { code?: string | undefined; message?: string | undefined } | null;

/** Postgres SQLSTATE → Gateway error code (RPCs raise these deliberately). */
export function mapPgError(e: PgError, where: string): GatewayError {
  const code = e?.code ?? 'unknown';
  const detail = `${where}:${code}`;
  switch (code) {
    case 'P0002':
      return gatewayError('not_found', detail);
    case '22023':
    case '23514':
    case '22P02':
      return gatewayError('invalid_input', detail);
    case '23505':
      return gatewayError('duplicate', detail);
    case '55000':
    case '55P03':
      return gatewayError('conflict', detail);
    default:
      return gatewayError('internal', detail, { transient: true });
  }
}

export async function rpc<T>(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<Result<T>> {
  try {
    const { data, error } = await db.rpc(fn, args);
    if (error) {
      const ge = mapPgError(error, `rpc.${fn}`);
      if (ge.code === 'internal') logError('rpc_failed', { fn, code: error.code ?? null });
      return err(ge);
    }
    return ok(data as T);
  } catch {
    logError('rpc_threw', { fn });
    return err(gatewayError('internal', `rpc.${fn}:threw`, { transient: true }));
  }
}

/** First row of a set-returning RPC (`returns table`), or null. */
export async function rpcRow<T>(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<Result<T | null>> {
  const r = await rpc<T[] | T | null>(db, fn, args);
  if (!r.ok) return r;
  const v = r.value;
  if (Array.isArray(v)) return ok((v[0] as T | undefined) ?? null);
  return ok(v ?? null);
}

/** Awaits a query builder and maps its error. */
export async function query<T>(
  builder: PromiseLike<{ data: unknown; error: PgError }>,
  where: string,
): Promise<Result<T>> {
  try {
    const { data, error } = await builder;
    if (error) {
      const ge = mapPgError(error, where);
      if (ge.code === 'internal') logError('query_failed', { where, code: error.code ?? null });
      return err(ge);
    }
    return ok(data as T);
  } catch {
    logError('query_threw', { where });
    return err(gatewayError('internal', `${where}:threw`, { transient: true }));
  }
}

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
