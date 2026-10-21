/**
 * `inspect`: prints the REAL schema of the legacy SQLite file (tables, columns, row counts) and a
 * diff against the ASSUMED schema in legacy-schema.ts. Never prints row contents. The only
 * value-derived output is aggregate:
 *  - for assumed timestamp columns: how many values look like ms / seconds / other;
 *  - for assumed categorical columns: value -> count, and only when every value is a short
 *    identifier-like token (no spaces, no long digit runs such as phone numbers); otherwise just
 *    the number of distinct values.
 */
import { ASSUMED_SCHEMA, LEGACY_TABLES, type LegacyTable } from './legacy-schema';
import { listTables, type SqliteDb } from './extract';

export interface InspectColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

export interface InspectTable {
  name: string;
  rowCount: number;
  columns: InspectColumn[];
  assumed: boolean;
  missingColumns: string[];
  extraColumns: string[];
  typeMismatches: { column: string; assumed: string; actual: string }[];
  timestampMagnitudes: Record<
    string,
    { ms: number; seconds: number; other: number; nulls: number }
  >;
  categorical: Record<string, { distinct: number; values: Record<string, number> | null }>;
}

export interface InspectResult {
  tables: InspectTable[];
  missingTables: LegacyTable[];
  unexpectedTables: string[];
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:/+-]{0,32}$/;
const LONG_DIGITS = /\d{7,}/;

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function inspectDb(db: SqliteDb): InspectResult {
  const names = listTables(db);
  const present = new Set(names);
  const assumedNames = new Set<string>(LEGACY_TABLES);
  const tables: InspectTable[] = [];

  for (const name of names) {
    const columns = (
      db.prepare(`PRAGMA table_info(${q(name)})`).all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[]
    ).map((c) => ({ name: c.name, type: c.type, notNull: c.notnull === 1, pk: c.pk > 0 }));
    const rowCount = Number(
      (db.prepare(`SELECT count(*) AS n FROM ${q(name)}`).get() as { n: number }).n,
    );
    const t: InspectTable = {
      name,
      rowCount,
      columns,
      assumed: assumedNames.has(name),
      missingColumns: [],
      extraColumns: [],
      typeMismatches: [],
      timestampMagnitudes: {},
      categorical: {},
    };

    if (t.assumed) {
      const spec = ASSUMED_SCHEMA[name as LegacyTable];
      const actual = new Map(columns.map((c) => [c.name, c]));
      for (const [col, c] of Object.entries(spec.columns)) {
        const a = actual.get(col);
        if (!a) {
          t.missingColumns.push(col);
          continue;
        }
        if (a.type.toUpperCase() !== c.type) {
          t.typeMismatches.push({ column: col, assumed: c.type, actual: a.type || '(none)' });
        }
        if (c.ts) {
          const r = db
            .prepare(
              `SELECT
                 sum(CASE WHEN ${q(col)} IS NULL THEN 1 ELSE 0 END) AS nulls,
                 sum(CASE WHEN typeof(${q(col)}) = 'integer' AND ${q(col)} BETWEEN 1000000000000 AND 4102444800000 THEN 1 ELSE 0 END) AS ms,
                 sum(CASE WHEN typeof(${q(col)}) = 'integer' AND ${q(col)} BETWEEN 1000000000 AND 4102444800 THEN 1 ELSE 0 END) AS seconds,
                 count(*) AS n
               FROM ${q(name)}`,
            )
            .get() as {
            nulls: number | null;
            ms: number | null;
            seconds: number | null;
            n: number;
          };
          const nulls = r.nulls ?? 0;
          const ms = r.ms ?? 0;
          const seconds = r.seconds ?? 0;
          t.timestampMagnitudes[col] = { ms, seconds, nulls, other: r.n - nulls - ms - seconds };
        }
        if (c.enumLike) {
          const rows = db
            .prepare(
              `SELECT CAST(${q(col)} AS TEXT) AS v, count(*) AS n FROM ${q(name)} GROUP BY 1 ORDER BY 2 DESC LIMIT 51`,
            )
            .all() as { v: string | null; n: number }[];
          const safe =
            rows.length <= 50 &&
            rows.every((r) => r.v === null || (SAFE_TOKEN.test(r.v) && !LONG_DIGITS.test(r.v)));
          t.categorical[col] = {
            distinct: rows.length,
            values: safe ? Object.fromEntries(rows.map((r) => [r.v ?? '(null)', r.n])) : null,
          };
        }
      }
      for (const c of columns) if (!(c.name in spec.columns)) t.extraColumns.push(c.name);
    }
    tables.push(t);
  }

  return {
    tables,
    missingTables: LEGACY_TABLES.filter((t) => !present.has(t)),
    unexpectedTables: names.filter((n) => !assumedNames.has(n)),
  };
}

export function renderInspect(r: InspectResult): string {
  const out: string[] = ['# Legacy SQLite inspection', ''];
  out.push(
    `Assumed tables missing: ${r.missingTables.length ? r.missingTables.join(', ') : 'none'}`,
  );
  out.push(
    `Tables not in the assumed schema: ${r.unexpectedTables.length ? r.unexpectedTables.join(', ') : 'none'}`,
  );
  out.push('');
  for (const t of r.tables) {
    out.push(`## ${t.name} (${t.rowCount} rows)${t.assumed ? '' : ' [not in assumed schema]'}`);
    out.push('');
    out.push('| column | type | not null | pk |');
    out.push('|---|---|---|---|');
    for (const c of t.columns) {
      out.push(
        `| ${c.name} | ${c.type || '(none)'} | ${c.notNull ? 'yes' : ''} | ${c.pk ? 'yes' : ''} |`,
      );
    }
    if (t.assumed) {
      out.push('');
      out.push(`- missing columns: ${t.missingColumns.join(', ') || 'none'}`);
      out.push(`- extra columns: ${t.extraColumns.join(', ') || 'none'}`);
      if (t.typeMismatches.length) {
        out.push(
          `- type mismatches: ${t.typeMismatches.map((m) => `${m.column} (assumed ${m.assumed}, actual ${m.actual})`).join(', ')}`,
        );
      }
      for (const [col, m] of Object.entries(t.timestampMagnitudes)) {
        out.push(
          `- timestamp ${col}: ms=${m.ms} seconds=${m.seconds} other=${m.other} null=${m.nulls}`,
        );
      }
      for (const [col, c] of Object.entries(t.categorical)) {
        const vals = c.values
          ? Object.entries(c.values)
              .map(([v, n]) => `${v}=${n}`)
              .join(', ')
          : 'values not shown (free text or too many)';
        out.push(`- values ${col} (${c.distinct} distinct): ${vals}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}
