/**
 * Read-only extraction of the legacy SQLite file + zod validation of every row.
 * Never logs or returns row contents for rejected rows: only table, rowid, field path and code.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  LEGACY_TABLES,
  legacyRowSchemas,
  type LegacyData,
  type LegacyTable,
} from './legacy-schema';

export type SqliteDb = Database.Database;

/** A problem with one source row. `rowid` is the SQLite rowid; no values are ever included. */
export interface RowIssue {
  table: string;
  rowid: number | null;
  /** Machine-readable reason, e.g. `invalid:due_at:not_ms_epoch`, `duplicate_key`. */
  reason: string;
}

export interface Extracted {
  data: LegacyData;
  /** Rows that failed validation or a transform rule (they are NOT loaded). */
  rejects: RowIssue[];
  /** Tables of the assumed schema that do not exist in the file. */
  missingTables: LegacyTable[];
  /** sha256 + size of the SQLite file (provenance for the audit row). */
  source: { sha256: string; bytes: number };
}

/** Opens the legacy DB strictly read-only. The file is never modified. */
export function openLegacyDb(path: string): SqliteDb {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  // Belt and braces: refuse any write even through a bug in this tool.
  db.pragma('query_only = ON');
  return db;
}

export function fileFingerprint(path: string): { sha256: string; bytes: number } {
  const buf = readFileSync(path);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

export function listTables(db: SqliteDb): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** True when the table has an implicit rowid (not a WITHOUT ROWID table). */
function hasRowid(db: SqliteDb, table: string): boolean {
  try {
    db.prepare(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 0`).all();
    return true;
  } catch {
    return false;
  }
}

export function readTableRaw(
  db: SqliteDb,
  table: string,
): { rowid: number | null; row: Record<string, unknown> }[] {
  const q = quoteIdent(table);
  const withRowid = hasRowid(db, table);
  const sql = withRowid
    ? `SELECT rowid AS __legacy_rowid, * FROM ${q} ORDER BY rowid`
    : `SELECT * FROM ${q}`;
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  return rows.map((r) => {
    const { __legacy_rowid, ...row } = r;
    return { rowid: withRowid ? Number(__legacy_rowid) : null, row };
  });
}

/** zod issue -> `invalid:<path>:<code-or-message>` (never includes the offending value). */
function issueReason(issue: { path: PropertyKey[]; code: string; message: string }): string {
  const path = issue.path.map(String).join('.') || '(row)';
  // Our own messages are snake_case tokens; zod's default messages are prose (use the code).
  const detail = /^[a-z0-9_]+$/.test(issue.message) ? issue.message : issue.code;
  return `invalid:${path}:${detail}`;
}

export function extract(db: SqliteDb, sourcePath: string | null): Extracted {
  const present = new Set(listTables(db));
  const rejects: RowIssue[] = [];
  const missingTables: LegacyTable[] = [];
  const data = {} as Record<LegacyTable, unknown[]>;

  for (const table of LEGACY_TABLES) {
    data[table] = [];
    if (!present.has(table)) {
      missingTables.push(table);
      continue;
    }
    const schema = legacyRowSchemas[table];
    for (const { rowid, row } of readTableRaw(db, table)) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) {
        const reasons = [...new Set(parsed.error.issues.map(issueReason))];
        for (const reason of reasons) rejects.push({ table, rowid, reason });
        continue;
      }
      data[table].push({ ...parsed.data, __rowid: rowid ?? -1 });
    }
  }

  return {
    data: data as unknown as LegacyData,
    rejects,
    missingTables,
    source: sourcePath ? fileFingerprint(sourcePath) : { sha256: '', bytes: 0 },
  };
}
