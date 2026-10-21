/**
 * Load (ARCHITECTURE.md §9.3 step 4): idempotent upserts through a service connection
 * (DATABASE_URL; RLS does not apply to the table owner / service role).
 *
 *  - `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE <owned columns> IS DISTINCT FROM ...`,
 *    so a second run with the same input writes nothing (M1);
 *  - one transaction per table (FK order, see tables.ts) for `load`;
 *    dry-run executes everything in ONE transaction and rolls it back, so the plan shows the exact
 *    insert/update/unchanged counts without writing;
 *  - preflight aborts before any write on: unknown org, mapped account with another org/provider,
 *    natural-key collisions with rows not created by this migration;
 *  - one `audit_log` row via `audit_append` summarising the run (counts and ids only).
 */
import type { ClientBase } from 'pg';
import { PG_TYPE, TABLE_SPECS, TARGETS, type TableSpec, type TargetName } from './tables';
import type { Row, TransformResult } from './transform';

export interface TableLoadResult {
  name: TargetName;
  source: string;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface LoadReport {
  dryRun: boolean;
  tables: TableLoadResult[];
  auditId: string | null;
}

export interface LoadContext {
  orgId: string;
  baileysAccountId: string;
  cloudAccountId: string;
  /** Extra audit meta (source fingerprint, window, reject counts). Never row contents. */
  auditMeta: Record<string, unknown>;
}

const CHUNK = 500;

/** Whether `api_clients.key_prefix` accepts null (packages/mcp expects null for legacy keys). */
export async function probeLegacyKeyPrefix(client: ClientBase): Promise<'null' | 'sentinel'> {
  const r = await client.query<{ is_nullable: string }>(
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'api_clients' and column_name = 'key_prefix'`,
  );
  return r.rows[0]?.is_nullable === 'YES' ? 'null' : 'sentinel';
}

function pick(spec: TableSpec, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of spec.columns) out[c.name] = row[c.name] ?? null;
  return out;
}

function recordDef(spec: TableSpec): string {
  return spec.columns.map((c) => `${c.name} ${PG_TYPE[c.type]}`).join(', ');
}

export function upsertSql(spec: TableSpec): string {
  const names = spec.columns.map((c) => c.name);
  const owned = spec.columns.filter((c) => c.name !== 'id' && !c.insertOnly).map((c) => c.name);
  const tuple = (p: string) => `(${owned.map((n) => `${p}.${n}`).join(', ')})`;
  if (spec.mode === 'update') {
    return `update public.${spec.table} as t set ${owned.map((n) => `${n} = x.${n}`).join(', ')}
      from jsonb_to_recordset($1::jsonb) as x(${recordDef(spec)})
      where t.id = x.id and ${tuple('t')} is distinct from ${tuple('x')}
      returning false as inserted`;
  }
  return `insert into public.${spec.table} as t (${names.join(', ')})
    select ${names.join(', ')} from jsonb_to_recordset($1::jsonb) as x(${recordDef(spec)})
    on conflict (id) do update set ${owned.map((n) => `${n} = excluded.${n}`).join(', ')}
    where ${tuple('t')} is distinct from ${tuple('excluded')}
    returning (t.xmax::text = '0') as inserted`;
}

async function applyTable(
  client: ClientBase,
  spec: TableSpec,
  rows: Row[],
): Promise<TableLoadResult> {
  const res: TableLoadResult = {
    name: spec.name,
    source: spec.source,
    rows: rows.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
  };
  const sql = upsertSql(spec);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => pick(spec, r));
    if (spec.mode === 'update') {
      const ids = chunk.map((r) => r.id);
      const found = await client.query(
        `select count(*)::int as n from public.${spec.table} where id = any($1::uuid[])`,
        [ids],
      );
      if (found.rows[0].n !== ids.length) {
        throw new Error(`${spec.name}: target rows missing for update (ids ${ids.join(', ')})`);
      }
    }
    const r = await client.query<{ inserted: boolean }>(sql, [JSON.stringify(chunk)]);
    for (const x of r.rows) {
      if (x.inserted) res.inserted++;
      else res.updated++;
    }
  }
  res.unchanged = res.rows - res.inserted - res.updated;
  return res;
}

/** Problems that make the load unsafe. Messages contain ids and table names only. */
export async function preflight(
  client: ClientBase,
  ctx: LoadContext,
  rows: TransformResult['rows'],
): Promise<string[]> {
  const problems: string[] = [];
  const org = await client.query('select 1 from public.orgs where id = $1', [ctx.orgId]);
  if (org.rowCount === 0) problems.push(`org ${ctx.orgId} does not exist`);

  const accs = await client.query<{ id: string; org_id: string; provider: string }>(
    'select id::text, org_id::text, provider from public.accounts where id = any($1::uuid[])',
    [[ctx.baileysAccountId, ctx.cloudAccountId]],
  );
  for (const a of accs.rows) {
    const want = a.id === ctx.baileysAccountId ? 'baileys' : 'meta_cloud';
    if (a.org_id !== ctx.orgId) problems.push(`account ${a.id} belongs to another org`);
    if (a.provider !== want)
      problems.push(`account ${a.id} has provider ${a.provider}, expected ${want}`);
  }

  for (const name of TARGETS) {
    const spec = TABLE_SPECS[name];
    const list = rows[name];
    if (spec.mode !== 'upsert' || list.length === 0) continue;
    // ON CONFLICT (id) must never move a row of another org into this one.
    const foreign = await client.query<{ id: string }>(
      `select id::text from public.${spec.table} where id = any($1::uuid[]) and org_id <> $2`,
      [list.map((r) => r.id), ctx.orgId],
    );
    if (foreign.rowCount) {
      problems.push(
        `${spec.name}: ${foreign.rowCount} id(s) already used by another org (${foreign.rows
          .slice(0, 5)
          .map((x) => x.id)
          .join(', ')})`,
      );
    }
    for (const k of spec.naturalKeys) {
      const existing = await client.query<{ id: string; k: string | null }>(
        `select id::text as id, ${k.sql} as k from public.${spec.table} where org_id = $1`,
        [ctx.orgId],
      );
      const byKey = new Map<string, string>();
      for (const e of existing.rows) if (e.k !== null) byKey.set(e.k, e.id);
      let n = 0;
      const sample: string[] = [];
      for (const row of list) {
        const key = k.fromRow(row);
        if (key === null) continue;
        const holder = byKey.get(key);
        if (holder && holder !== row.id) {
          n++;
          if (sample.length < 5) sample.push(`${String(row.id)} vs existing ${holder}`);
        }
      }
      if (n > 0) {
        problems.push(
          `${spec.name}: ${n} row(s) collide on ${k.name} with rows not created by this migration (${sample.join('; ')})`,
        );
      }
    }
  }
  return problems;
}

export async function runLoad(
  client: ClientBase,
  t: TransformResult,
  ctx: LoadContext,
  opts: { dryRun: boolean },
): Promise<LoadReport> {
  const problems = await preflight(client, ctx, t.rows);
  if (problems.length > 0) {
    throw new Error(`preflight failed:\n- ${problems.join('\n- ')}`);
  }

  const tables: TableLoadResult[] = [];
  if (opts.dryRun) {
    await client.query('begin');
    try {
      for (const name of TARGETS)
        tables.push(await applyTable(client, TABLE_SPECS[name], t.rows[name]));
    } finally {
      await client.query('rollback');
    }
    return { dryRun: true, tables, auditId: null };
  }

  for (const name of TARGETS) {
    await client.query('begin');
    try {
      tables.push(await applyTable(client, TABLE_SPECS[name], t.rows[name]));
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
  }

  const meta = {
    ...ctx.auditMeta,
    accounts: { default: ctx.baileysAccountId, 'meta-default': ctx.cloudAccountId },
    tables: Object.fromEntries(
      tables.map((x) => [
        x.name,
        { rows: x.rows, inserted: x.inserted, updated: x.updated, unchanged: x.unchanged },
      ]),
    ),
  };
  const a = await client.query<{ id: string }>(
    `select public.audit_append($1::uuid, 'system', 'scripts/migrate', 'legacy_migration.load',
       'whatsapp-automation', null, $2::jsonb)::text as id`,
    [ctx.orgId, JSON.stringify(meta)],
  );
  return { dryRun: false, tables, auditId: a.rows[0]?.id ?? null };
}

export function renderLoad(r: LoadReport): string {
  const out = [
    r.dryRun ? '## Plan (dry run, rolled back)' : '## Load',
    '',
    '| target | source | rows | insert | update | unchanged |',
    '|---|---|---|---|---|---|',
  ];
  for (const t of r.tables) {
    out.push(
      `| ${t.name} | ${t.source} | ${t.rows} | ${t.inserted} | ${t.updated} | ${t.unchanged} |`,
    );
  }
  if (r.auditId) out.push('', `audit_log row: ${r.auditId}`);
  return out.join('\n');
}
