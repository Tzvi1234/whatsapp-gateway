/**
 * Test-only in-memory stand-in for the supabase-js client surface this app uses
 * (`rpc`, chained `from()` queries, `storage.createSignedUrl`). Not imported by app code.
 */
import type { Db } from '../supabase';
import { parseEnv, type Env } from '../env';

export type DbResult = { data?: unknown; error?: { code?: string; message?: string } | null };

export interface TableOp {
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete';
  columns: string | null;
  payload: unknown;
  filters: [string, ...unknown[]][];
  single: 'single' | 'maybe' | null;
}

export interface FakeDbOptions {
  rpc?: Record<string, (args: Record<string, unknown>) => DbResult | Promise<DbResult>>;
  table?: (op: TableOp) => DbResult | Promise<DbResult>;
}

export interface FakeDb {
  db: Db;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  ops: TableOp[];
  calledRpc(fn: string): { fn: string; args: Record<string, unknown> }[];
}

export function createFakeDb(opts: FakeDbOptions = {}): FakeDb {
  const rpcCalls: FakeDb['rpcCalls'] = [];
  const ops: TableOp[] = [];

  function builder(table: string) {
    const op: TableOp = {
      table,
      action: 'select',
      columns: null,
      payload: null,
      filters: [],
      single: null,
    };
    const b: Record<string, unknown> = {};
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        op.filters.push([name, ...args]);
        return b;
      };
    for (const m of ['eq', 'neq', 'in', 'is', 'not', 'lt', 'gt', 'order', 'limit', 'range']) {
      b[m] = chain(m);
    }
    b.select = (cols?: string) => {
      op.columns = cols ?? '*';
      return b;
    };
    b.insert = (p: unknown) => {
      op.action = 'insert';
      op.payload = p;
      return b;
    };
    b.update = (p: unknown) => {
      op.action = 'update';
      op.payload = p;
      return b;
    };
    b.delete = () => {
      op.action = 'delete';
      return b;
    };
    b.single = () => {
      op.single = 'single';
      return b;
    };
    b.maybeSingle = () => {
      op.single = 'maybe';
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve(opts.table ? opts.table(op) : { data: op.single ? null : [] })
        .then((r) => ({ data: r.data ?? null, error: r.error ?? null }))
        .then(resolve, reject);
    };
    return b;
  }

  const db = {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const h = opts.rpc?.[fn];
      if (!h) return { data: null, error: { code: 'PGRST202', message: `no fake for ${fn}` } };
      const r = await h(args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, ttl: number) => ({
          data: { signedUrl: `https://storage.example.test/${path}?ttl=${ttl}&token=signed` },
          error: null,
        }),
      }),
    },
  } as unknown as Db;

  return {
    db,
    rpcCalls,
    ops,
    calledRpc: (fn) => rpcCalls.filter((c) => c.fn === fn),
  };
}

/** Fictitious, syntactically valid environment for tests. */
export function testEnv(over: Record<string, string> = {}): Env {
  return parseEnv({
    PUBLIC_BASE_URL: 'https://gateway.example.test',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-tests-0000000000',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests-000000',
    INTERNAL_API_SECRET: 'internal-secret-for-tests-0123456789abcdef',
    RELAY_ALLOWED_HOSTS: 'hooks.grok.example.test',
    LIA_ALLOWLIST_SEED: '050-000-0001',
    ...over,
  });
}
