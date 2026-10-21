/**
 * Local SQLite backend (spike / single host). Ciphertext only; sealing happens in
 * EncryptedSessionStore via crypto.ts. Database file and directory are created 0600/0700.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SessionCipher } from './crypto';
import { EncryptedSessionStore } from './encrypted-store';
import type { RecordBackend, SealedRow, SessionStore } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS baileys_auth_state (
  account_id  TEXT    NOT NULL,
  key_type    TEXT    NOT NULL,
  key_id      TEXT    NOT NULL,
  ciphertext  BLOB    NOT NULL,
  nonce       BLOB    NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, key_type, key_id)
) WITHOUT ROWID;
`;

const CHUNK = 500;

interface DbRow {
  key_type: string;
  key_id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
}

function tighten(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* file may not exist yet (wal/shm) */
  }
}

export class SqliteRecordBackend implements RecordBackend {
  readonly #db: Database.Database;
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
      tighten(file, 0o600);
    }
    this.#db = new Database(file);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.pragma('secure_delete = ON');
    this.#db.exec(SCHEMA);
    this.#tightenSidecars();
  }

  #tightenSidecars(): void {
    if (this.#file === ':memory:') return;
    tighten(this.#file, 0o600);
    tighten(`${this.#file}-wal`, 0o600);
    tighten(`${this.#file}-shm`, 0o600);
  }

  async get(accountId: string, keyType: string, keyIds: readonly string[]): Promise<SealedRow[]> {
    const out: SealedRow[] = [];
    for (let i = 0; i < keyIds.length; i += CHUNK) {
      const chunk = keyIds.slice(i, i + CHUNK);
      const stmt = this.#db.prepare<unknown[], DbRow>(
        `SELECT key_type, key_id, ciphertext, nonce, key_version FROM baileys_auth_state
         WHERE account_id = ? AND key_type = ? AND key_id IN (${chunk.map(() => '?').join(',')})`,
      );
      for (const r of stmt.all(accountId, keyType, ...chunk)) {
        out.push({
          keyType: r.key_type,
          keyId: r.key_id,
          keyVersion: r.key_version,
          nonce: r.nonce,
          ciphertext: r.ciphertext,
        });
      }
    }
    return out;
  }

  async write(
    accountId: string,
    upserts: readonly SealedRow[],
    deletes: ReadonlyArray<{ keyType: string; keyId: string }>,
  ): Promise<void> {
    const up = this.#db.prepare(
      `INSERT INTO baileys_auth_state (account_id, key_type, key_id, ciphertext, nonce, key_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, key_type, key_id) DO UPDATE SET
         ciphertext = excluded.ciphertext, nonce = excluded.nonce,
         key_version = excluded.key_version, updated_at = excluded.updated_at`,
    );
    const del = this.#db.prepare(
      'DELETE FROM baileys_auth_state WHERE account_id = ? AND key_type = ? AND key_id = ?',
    );
    const now = Date.now();
    this.#db.transaction(() => {
      for (const r of upserts) {
        up.run(
          accountId,
          r.keyType,
          r.keyId,
          Buffer.from(r.ciphertext),
          Buffer.from(r.nonce),
          r.keyVersion,
          now,
        );
      }
      for (const d of deletes) del.run(accountId, d.keyType, d.keyId);
    })();
    this.#tightenSidecars();
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.#db.prepare('DELETE FROM baileys_auth_state WHERE account_id = ?').run(accountId);
    this.#db.pragma('wal_checkpoint(TRUNCATE)');
  }

  async close(): Promise<void> {
    if (this.#db.open) this.#db.close();
  }

  /** Test/inspection hook: raw rows (ciphertext only). */
  rawRows(accountId?: string): Array<DbRow & { account_id: string }> {
    const sql =
      'SELECT account_id, key_type, key_id, ciphertext, nonce, key_version FROM baileys_auth_state';
    return (
      accountId
        ? this.#db.prepare(`${sql} WHERE account_id = ?`).all(accountId)
        : this.#db.prepare(sql).all()
    ) as Array<DbRow & { account_id: string }>;
  }

  /** Test/inspection hook: write a raw row as-is (used to simulate copied/tampered rows). */
  putRaw(accountId: string, row: SealedRow): void {
    void this.write(accountId, [row], []);
  }
}

export interface SqliteSessionStoreOptions {
  /** Path to `session.sqlite` (created 0600, parent dir 0700). `:memory:` for tests. */
  file: string;
  accountId: string;
  cipher: SessionCipher;
}

export function createSqliteSessionStore(opts: SqliteSessionStoreOptions): SessionStore {
  return new EncryptedSessionStore(opts.accountId, new SqliteRecordBackend(opts.file), opts.cipher);
}
