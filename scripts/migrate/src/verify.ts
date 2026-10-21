/**
 * Diff report (TEST-PLAN M2): per target table, count + per-row SHA-256 over canonical JSON of the
 * transformed source vs the rows read back from Postgres, using the same projection
 * (`verifiedColumns`). Mismatches are reported by id and column NAME only (never values).
 */
import type { ClientBase } from 'pg';
import { canonicalJson, project, sha256Hex } from './canonical';
import type { RowIssue } from './extract';
import { TABLE_SPECS, TARGETS, verifiedColumns, type TableSpec, type TargetName } from './tables';
import type { Row, TransformResult } from './transform';

export interface TableDiff {
  name: TargetName;
  source: string;
  sourceCount: number;
  targetCount: number;
  matched: number;
  missing: string[];
  mismatched: { id: string; columns: string[] }[];
  /** sha256 over the sorted `id:rowhash` lines of each side. Equal iff the table matches. */
  sourceDigest: string;
  targetDigest: string;
}

export interface VerifyReport {
  ok: boolean;
  generatedAt: string;
  cutoff: string;
  source: { sha256: string; bytes: number };
  tables: TableDiff[];
  rejects: RowIssue[];
  warnings: RowIssue[];
  missingTables: string[];
}

type Projected = Record<string, unknown>;

function digest(entries: [string, string][]): string {
  return sha256Hex(
    entries
      .map(([id, h]) => `${id}:${h}`)
      .sort()
      .join('\n'),
  );
}

/** Pure comparison of one table (exported for tests). */
export function diffTable(spec: TableSpec, source: Row[], target: Projected[]): TableDiff {
  const cols = verifiedColumns(spec);
  const targetById = new Map<string, Projected>();
  for (const t of target) {
    const p = project(t, cols);
    targetById.set(String(p.id), p);
  }
  const srcEntries: [string, string][] = [];
  const tgtEntries: [string, string][] = [];
  const missing: string[] = [];
  const mismatched: { id: string; columns: string[] }[] = [];
  let matched = 0;
  for (const row of source) {
    const s = project(row, cols);
    const id = String(s.id);
    const sh = sha256Hex(canonicalJson(s));
    srcEntries.push([id, sh]);
    const t = targetById.get(id);
    if (!t) {
      missing.push(id);
      continue;
    }
    const th = sha256Hex(canonicalJson(t));
    tgtEntries.push([id, th]);
    if (sh === th) {
      matched++;
      continue;
    }
    mismatched.push({
      id,
      columns: cols.map((c) => c.name).filter((n) => canonicalJson(s[n]) !== canonicalJson(t[n])),
    });
  }
  return {
    name: spec.name,
    source: spec.source,
    sourceCount: source.length,
    targetCount: tgtEntries.length,
    matched,
    missing,
    mismatched,
    sourceDigest: digest(srcEntries),
    targetDigest: digest(tgtEntries),
  };
}

export async function readBack(
  client: ClientBase,
  spec: TableSpec,
  ids: string[],
): Promise<Projected[]> {
  if (ids.length === 0) return [];
  const cols = verifiedColumns(spec)
    .map((c) => c.name)
    .join(', ');
  const r = await client.query<{ j: Projected }>(
    `select to_jsonb(x) as j from (select ${cols} from public.${spec.table} where id = any($1::uuid[])) x`,
    [ids],
  );
  return r.rows.map((x) => x.j);
}

export async function runVerify(
  client: ClientBase,
  t: TransformResult,
  meta: {
    source: { sha256: string; bytes: number };
    rejects: RowIssue[];
    missingTables: string[];
    now: Date;
  },
): Promise<VerifyReport> {
  const tables: TableDiff[] = [];
  for (const name of TARGETS) {
    const spec = TABLE_SPECS[name];
    const rows = t.rows[name];
    const target = await readBack(
      client,
      spec,
      rows.map((r) => String(r.id)),
    );
    tables.push(diffTable(spec, rows, target));
  }
  return {
    ok: tables.every((x) => x.missing.length === 0 && x.mismatched.length === 0),
    generatedAt: meta.now.toISOString(),
    cutoff: t.cutoff,
    source: meta.source,
    tables,
    rejects: [...meta.rejects, ...t.rejects],
    warnings: t.warnings,
    missingTables: meta.missingTables,
  };
}

export function renderVerify(r: VerifyReport): string {
  const out = [
    '# Legacy migration diff report (M2)',
    '',
    `- result: **${r.ok ? 'OK, no differences' : 'DIFFERENCES FOUND'}**`,
    `- generated: ${r.generatedAt}`,
    `- window cutoff (chat_messages, terminal reminders): ${r.cutoff}`,
    `- source sqlite sha256: ${r.source.sha256} (${r.source.bytes} bytes)`,
    `- legacy tables missing: ${r.missingTables.join(', ') || 'none'}`,
    `- rejected source rows (not loaded): ${r.rejects.length}`,
    `- warnings (loaded with adjustment): ${r.warnings.length}`,
    '',
    '| target | source | source rows | found | matched | missing | mismatched | digest equal |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const t of r.tables) {
    out.push(
      `| ${t.name} | ${t.source} | ${t.sourceCount} | ${t.targetCount} | ${t.matched} | ${t.missing.length} | ${t.mismatched.length} | ${t.sourceDigest === t.targetDigest ? 'yes' : 'no'} |`,
    );
  }
  for (const t of r.tables) {
    if (t.missing.length === 0 && t.mismatched.length === 0) continue;
    out.push('', `## ${t.name}`, '');
    for (const id of t.missing) out.push(`- missing: ${id}`);
    for (const m of t.mismatched)
      out.push(`- mismatch: ${m.id} (columns: ${m.columns.join(', ')})`);
  }
  out.push('', '## Table digests', '');
  for (const t of r.tables)
    out.push(`- ${t.name}: source ${t.sourceDigest} / target ${t.targetDigest}`);
  if (r.rejects.length) {
    out.push('', '## Rejected source rows', '', '| table | rowid | reason |', '|---|---|---|');
    for (const x of r.rejects) out.push(`| ${x.table} | ${x.rowid ?? ''} | ${x.reason} |`);
  }
  if (r.warnings.length) {
    out.push('', '## Warnings', '', '| table | rowid | reason |', '|---|---|---|');
    for (const x of r.warnings) out.push(`| ${x.table} | ${x.rowid ?? ''} | ${x.reason} |`);
  }
  return out.join('\n') + '\n';
}
