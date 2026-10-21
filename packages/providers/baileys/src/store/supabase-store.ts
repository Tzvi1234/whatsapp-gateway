/**
 * Production backend over table `baileys_auth_state(account_id, key_type, key_id, ciphertext
 * bytea, nonce, key_version)` (ARCH §5, ADR-4). This package does NOT import supabase-js: the
 * worker adapts its `gateway_worker` client to `BaileysAuthStateDb`. Ciphertext only.
 */
import type { SessionCipher } from './crypto';
import { EncryptedSessionStore } from './encrypted-store';
import type { RecordBackend, SealedRow, SessionStore } from './types';

/** Row shape of `baileys_auth_state` (snake_case, as in Postgres). */
export interface BaileysAuthStateRow {
  account_id: string;
  key_type: string;
  key_id: string;
  /** bytea; the adapter converts PostgREST's `\x…` hex to bytes and back. */
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  key_version: number;
}

export interface BaileysAuthStateKey {
  key_type: string;
  key_id: string;
}

/** Minimal DB client the worker implements (e.g. via RPCs callable by `gateway_worker`). */
export interface BaileysAuthStateDb {
  select(
    accountId: string,
    keyType: string,
    keyIds: readonly string[],
  ): Promise<BaileysAuthStateRow[]>;
  /** Upsert on PK (account_id, key_type, key_id). Must resolve only after commit. */
  upsert(rows: readonly BaileysAuthStateRow[]): Promise<void>;
  delete(accountId: string, keys: readonly BaileysAuthStateKey[]): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;
  /**
   * Optional atomic upsert+delete in one transaction (single RPC). Preferred when present so a
   * `keys.set` batch is all-or-nothing.
   */
  apply?(
    accountId: string,
    upserts: readonly BaileysAuthStateRow[],
    deletes: readonly BaileysAuthStateKey[],
  ): Promise<void>;
}

/** Keeps PostgREST `in.(…)` filters and RPC payloads bounded. */
const SELECT_CHUNK = 200;
const UPSERT_CHUNK = 500;

export class SupabaseRecordBackend implements RecordBackend {
  readonly #db: BaileysAuthStateDb;
  constructor(db: BaileysAuthStateDb) {
    this.#db = db;
  }

  async get(accountId: string, keyType: string, keyIds: readonly string[]): Promise<SealedRow[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < keyIds.length; i += SELECT_CHUNK)
      chunks.push(keyIds.slice(i, i + SELECT_CHUNK));
    const results = await Promise.all(chunks.map((c) => this.#db.select(accountId, keyType, c)));
    return results.flat().map((r) => {
      if (r.account_id !== accountId || r.key_type !== keyType)
        throw new Error('baileys_auth_state: adapter returned a row for another key');
      return {
        keyType: r.key_type,
        keyId: r.key_id,
        keyVersion: r.key_version,
        nonce: r.nonce,
        ciphertext: r.ciphertext,
      };
    });
  }

  async write(
    accountId: string,
    upserts: readonly SealedRow[],
    deletes: ReadonlyArray<{ keyType: string; keyId: string }>,
  ): Promise<void> {
    const rows: BaileysAuthStateRow[] = upserts.map((r) => ({
      account_id: accountId,
      key_type: r.keyType,
      key_id: r.keyId,
      ciphertext: r.ciphertext,
      nonce: r.nonce,
      key_version: r.keyVersion,
    }));
    const dels: BaileysAuthStateKey[] = deletes.map((d) => ({
      key_type: d.keyType,
      key_id: d.keyId,
    }));
    if (this.#db.apply) {
      await this.#db.apply(accountId, rows, dels);
      return;
    }
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK)
      await this.#db.upsert(rows.slice(i, i + UPSERT_CHUNK));
    if (dels.length) await this.#db.delete(accountId, dels);
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.#db.deleteAccount(accountId);
  }

  async close(): Promise<void> {
    /* the worker owns the client */
  }
}

export interface SupabaseSessionStoreOptions {
  db: BaileysAuthStateDb;
  accountId: string;
  cipher: SessionCipher;
}

export function createSupabaseSessionStore(opts: SupabaseSessionStoreOptions): SessionStore {
  return new EncryptedSessionStore(opts.accountId, new SupabaseRecordBackend(opts.db), opts.cipher);
}

/**
 * In-memory `BaileysAuthStateDb` for tests and local dry runs. Copies bytes on the way in and out
 * like a real DB would, and records calls so tests can assert batching.
 */
export class InMemoryBaileysAuthStateDb implements BaileysAuthStateDb {
  readonly rows = new Map<string, BaileysAuthStateRow>();
  readonly calls: Array<{ op: string; n: number }> = [];

  static #k(a: string, t: string, i: string): string {
    return JSON.stringify([a, t, i]);
  }

  static #copy(r: BaileysAuthStateRow): BaileysAuthStateRow {
    return { ...r, ciphertext: Uint8Array.from(r.ciphertext), nonce: Uint8Array.from(r.nonce) };
  }

  async select(
    accountId: string,
    keyType: string,
    keyIds: readonly string[],
  ): Promise<BaileysAuthStateRow[]> {
    this.calls.push({ op: 'select', n: keyIds.length });
    const out: BaileysAuthStateRow[] = [];
    for (const id of keyIds) {
      const r = this.rows.get(InMemoryBaileysAuthStateDb.#k(accountId, keyType, id));
      if (r) out.push(InMemoryBaileysAuthStateDb.#copy(r));
    }
    return out;
  }

  async upsert(rows: readonly BaileysAuthStateRow[]): Promise<void> {
    this.calls.push({ op: 'upsert', n: rows.length });
    for (const r of rows)
      this.rows.set(
        InMemoryBaileysAuthStateDb.#k(r.account_id, r.key_type, r.key_id),
        InMemoryBaileysAuthStateDb.#copy(r),
      );
  }

  async delete(accountId: string, keys: readonly BaileysAuthStateKey[]): Promise<void> {
    this.calls.push({ op: 'delete', n: keys.length });
    for (const k of keys)
      this.rows.delete(InMemoryBaileysAuthStateDb.#k(accountId, k.key_type, k.key_id));
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.calls.push({ op: 'deleteAccount', n: 1 });
    for (const [k, r] of this.rows) if (r.account_id === accountId) this.rows.delete(k);
  }
}
