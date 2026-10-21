/**
 * `BaileysAuthStateDb` adapter for table `baileys_auth_state` (ADR-4). Ciphertext only: rows are
 * sealed by `@htz/provider-baileys` before they reach this module.
 *
 * PostgREST serialises `bytea` as `\x<hex>` strings; this module converts to/from Uint8Array.
 * There is no atomic multi-row RPC for this table, so `apply` is not provided: upserts go
 * first (one PostgREST request = one committed transaction), deletes after. Every call resolves
 * only after the HTTP response, i.e. after commit.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BaileysAuthStateDb,
  BaileysAuthStateKey,
  BaileysAuthStateRow,
} from '@htz/provider-baileys';
import { DbError } from './supabase-db';

/** Row as PostgREST sees it. */
export interface RawAuthStateRow {
  org_id?: string;
  account_id: string;
  key_type: string;
  key_id: string;
  ciphertext: string;
  nonce: string;
  key_version: number;
}

/** The four table operations; implemented over supabase-js below and in-memory in tests. */
export interface AuthStateTable {
  select(accountId: string, keyType: string, keyIds: readonly string[]): Promise<RawAuthStateRow[]>;
  upsert(rows: readonly RawAuthStateRow[]): Promise<void>;
  delete(accountId: string, keyType: string, keyIds: readonly string[]): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;
}

export function bytesToPgHex(b: Uint8Array): string {
  return `\\x${Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')}`;
}

export function pgHexToBytes(v: unknown): Uint8Array {
  if (typeof v !== 'string' || !v.startsWith('\\x') || (v.length - 2) % 2 !== 0) {
    throw new Error('baileys_auth_state: unexpected bytea encoding');
  }
  const hex = v.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('baileys_auth_state: invalid hex');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function createBaileysAuthStateDb(table: AuthStateTable, orgId: string): BaileysAuthStateDb {
  const toRaw = (r: BaileysAuthStateRow): RawAuthStateRow => ({
    org_id: orgId,
    account_id: r.account_id,
    key_type: r.key_type,
    key_id: r.key_id,
    ciphertext: bytesToPgHex(r.ciphertext),
    nonce: bytesToPgHex(r.nonce),
    key_version: r.key_version,
  });
  return {
    async select(accountId, keyType, keyIds) {
      if (keyIds.length === 0) return [];
      const rows = await table.select(accountId, keyType, keyIds);
      return rows.map((r) => ({
        account_id: r.account_id,
        key_type: r.key_type,
        key_id: r.key_id,
        ciphertext: pgHexToBytes(r.ciphertext),
        nonce: pgHexToBytes(r.nonce),
        key_version: r.key_version,
      }));
    },
    async upsert(rows) {
      if (rows.length === 0) return;
      await table.upsert(rows.map(toRaw));
    },
    async delete(accountId, keys: readonly BaileysAuthStateKey[]) {
      const byType = new Map<string, string[]>();
      for (const k of keys) {
        const list = byType.get(k.key_type) ?? [];
        list.push(k.key_id);
        byType.set(k.key_type, list);
      }
      for (const [t, ids] of byType) await table.delete(accountId, t, ids);
    },
    deleteAccount: (accountId) => table.deleteAccount(accountId),
  };
}

/** Ids PostgREST's `in.(…)` quoting cannot express safely are queried one by one. */
const UNSAFE_IN = /["\\]/;

export function supabaseAuthStateTable(client: SupabaseClient): AuthStateTable {
  const T = 'baileys_auth_state';
  const COLS = 'account_id, key_type, key_id, ciphertext, nonce, key_version';
  const fail = (op: string, e: { code?: string; message?: string }) =>
    new DbError(`${T}.${op}`, e.code ?? null, (e.message ?? '').slice(0, 160));
  return {
    async select(accountId, keyType, keyIds) {
      const safe = keyIds.filter((k) => !UNSAFE_IN.test(k));
      const unsafe = keyIds.filter((k) => UNSAFE_IN.test(k));
      const out: RawAuthStateRow[] = [];
      if (safe.length) {
        const r = await client
          .from(T)
          .select(COLS)
          .eq('account_id', accountId)
          .eq('key_type', keyType)
          .in('key_id', safe);
        if (r.error) throw fail('select', r.error);
        out.push(...((r.data ?? []) as RawAuthStateRow[]));
      }
      for (const k of unsafe) {
        const r = await client
          .from(T)
          .select(COLS)
          .eq('account_id', accountId)
          .eq('key_type', keyType)
          .eq('key_id', k);
        if (r.error) throw fail('select', r.error);
        out.push(...((r.data ?? []) as RawAuthStateRow[]));
      }
      return out;
    },
    async upsert(rows) {
      const r = await client
        .from(T)
        .upsert(rows as RawAuthStateRow[], { onConflict: 'account_id,key_type,key_id' });
      if (r.error) throw fail('upsert', r.error);
    },
    async delete(accountId, keyType, keyIds) {
      const safe = keyIds.filter((k) => !UNSAFE_IN.test(k));
      const unsafe = keyIds.filter((k) => UNSAFE_IN.test(k));
      if (safe.length) {
        const r = await client
          .from(T)
          .delete()
          .eq('account_id', accountId)
          .eq('key_type', keyType)
          .in('key_id', safe);
        if (r.error) throw fail('delete', r.error);
      }
      for (const k of unsafe) {
        const r = await client
          .from(T)
          .delete()
          .eq('account_id', accountId)
          .eq('key_type', keyType)
          .eq('key_id', k);
        if (r.error) throw fail('delete', r.error);
      }
    },
    async deleteAccount(accountId) {
      const r = await client.from(T).delete().eq('account_id', accountId);
      if (r.error) throw fail('deleteAccount', r.error);
    },
  };
}
