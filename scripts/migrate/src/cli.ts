/**
 * Legacy WhatsApp-Automation -> Gateway migration CLI (PLAN task 4.1, ARCHITECTURE.md §9.3).
 *
 *   migrate inspect --sqlite <path> [--json]
 *   migrate plan    --sqlite <path> --org <uuid> --baileys-account <uuid> --cloud-account <uuid>
 *                   [--database-url <url> | env DATABASE_URL] [--since-days 30] [--report-dir <dir>]
 *   migrate load    ...same... [--accept-rejects]
 *   migrate verify  ...same...
 *
 * The SQLite file is opened read-only and never modified. Output contains counts, ids, table and
 * column names only: never message bodies, tokens/hashes or phone numbers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { extract, openLegacyDb, type Extracted } from './extract';
import { inspectDb, renderInspect } from './inspect';
import { LEGACY_TABLES } from './legacy-schema';
import { probeLegacyKeyPrefix, renderLoad, runLoad } from './load';
import { TARGETS } from './tables';
import { isUuid, transform, type TransformResult } from './transform';
import { renderVerify, runVerify } from './verify';

const USAGE = `usage:
  migrate inspect --sqlite <path> [--json]
  migrate plan|load|verify --sqlite <path> --org <uuid> --baileys-account <uuid> --cloud-account <uuid>
      [--database-url <url>] (or env DATABASE_URL) [--since-days 30] [--now <iso>]
      [--report-dir <dir>] [--accept-rejects (load only)]`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
  err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
  env: process.env,
};

class UsageError extends Error {}

function summarise(ex: Extracted, t: TransformResult): string {
  const out = ['## Source', '', '| legacy table | valid rows |', '|---|---|'];
  for (const name of LEGACY_TABLES) out.push(`| ${name} | ${ex.data[name].length} |`);
  out.push('', `- missing legacy tables: ${ex.missingTables.join(', ') || 'none'}`);
  const rejects = [...ex.rejects, ...t.rejects];
  out.push(`- rejected rows: ${rejects.length}`);
  for (const r of rejects) out.push(`  - ${r.table} rowid ${r.rowid ?? '?'}: ${r.reason}`);
  out.push(`- warnings: ${t.warnings.length}`);
  for (const w of t.warnings) out.push(`  - ${w.table} rowid ${w.rowid ?? '?'}: ${w.reason}`);
  out.push(`- window cutoff: ${t.cutoff}`);
  for (const [k, n] of Object.entries(t.excludedByWindow)) {
    out.push(`- excluded by window: ${k} ${n}`);
  }
  out.push('', '## Target rows', '', '| target | rows |', '|---|---|');
  for (const name of TARGETS) out.push(`| ${name} | ${t.rows[name].length} |`);
  return out.join('\n');
}

function writeReport(dir: string, base: string, md: string, json: unknown): string[] {
  mkdirSync(dir, { recursive: true });
  const md5 = join(dir, `${base}.md`);
  const js = join(dir, `${base}.json`);
  writeFileSync(md5, md);
  writeFileSync(js, `${JSON.stringify(json, null, 2)}\n`);
  return [md5, js];
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        sqlite: { type: 'string' },
        'database-url': { type: 'string' },
        'baileys-account': { type: 'string' },
        'cloud-account': { type: 'string' },
        org: { type: 'string' },
        'since-days': { type: 'string', default: '30' },
        now: { type: 'string' },
        'report-dir': { type: 'string' },
        'accept-rejects': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}`);
    return 64;
  }

  try {
    if (!command || !['inspect', 'plan', 'load', 'verify'].includes(command)) {
      throw new UsageError(`unknown command ${command ?? '(none)'}`);
    }
    if (!values.sqlite) throw new UsageError('--sqlite is required');
    const sqlitePath = resolve(values.sqlite);

    if (command === 'inspect') {
      const db = openLegacyDb(sqlitePath);
      try {
        const r = inspectDb(db);
        io.out(values.json ? JSON.stringify(r, null, 2) : renderInspect(r));
      } finally {
        db.close();
      }
      return 0;
    }

    const org = values.org;
    const baileys = values['baileys-account'];
    const cloud = values['cloud-account'];
    for (const [flag, v] of [
      ['--org', org],
      ['--baileys-account', baileys],
      ['--cloud-account', cloud],
    ] as const) {
      if (!v || !isUuid(v)) throw new UsageError(`${flag} must be a UUID`);
    }
    if (baileys!.toLowerCase() === cloud!.toLowerCase()) {
      throw new UsageError('--baileys-account and --cloud-account must differ');
    }
    const sinceDays = Number(values['since-days']);
    if (!Number.isInteger(sinceDays) || sinceDays < 1) {
      throw new UsageError('--since-days must be a positive integer');
    }
    const now = values.now ? new Date(values.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new UsageError('--now must be an ISO timestamp');
    const databaseUrl = values['database-url'] ?? io.env.DATABASE_URL;
    if (command !== 'plan' && !databaseUrl) {
      throw new UsageError('--database-url or env DATABASE_URL is required');
    }
    const reportDir = resolve(values['report-dir'] ?? 'migrate-reports');
    const stamp = now.toISOString().replace(/[:.]/g, '-');

    const db = openLegacyDb(sqlitePath);
    let ex: Extracted;
    try {
      ex = extract(db, sqlitePath);
    } finally {
      db.close();
    }

    const client = databaseUrl
      ? new pg.Client({ connectionString: databaseUrl, application_name: 'htz-migrate' })
      : null;
    if (client) await client.connect();
    try {
      const legacyKeyPrefix = client ? await probeLegacyKeyPrefix(client) : 'null';
      if (legacyKeyPrefix === 'sentinel') {
        io.err(
          'note: api_clients.key_prefix is NOT NULL in this database; legacy keys get key_prefix "legacy-<id>"',
        );
      }
      const t = transform(ex.data, {
        orgId: org!.toLowerCase(),
        baileysAccountId: baileys!.toLowerCase(),
        cloudAccountId: cloud!.toLowerCase(),
        sinceDays,
        now,
        legacyKeyPrefix,
      });
      const summary = summarise(ex, t);
      const rejectCount = ex.rejects.length + t.rejects.length;
      const ctx = {
        orgId: org!.toLowerCase(),
        baileysAccountId: baileys!.toLowerCase(),
        cloudAccountId: cloud!.toLowerCase(),
        auditMeta: {
          source_sha256: ex.source.sha256,
          source_bytes: ex.source.bytes,
          since_days: sinceDays,
          cutoff: t.cutoff,
          rejects: rejectCount,
          warnings: t.warnings.length,
          missing_legacy_tables: ex.missingTables,
        },
      };

      if (command === 'plan') {
        io.out(summary);
        let md = `# Migration plan\n\n${summary}\n`;
        let loadReport = null;
        if (client) {
          loadReport = await runLoad(client, t, ctx, { dryRun: true });
          const lr = renderLoad(loadReport);
          io.out(`\n${lr}`);
          md += `\n${lr}\n`;
        } else {
          io.out('\n(no database url: offline plan only, no insert/update counts)');
        }
        const files = writeReport(reportDir, `plan-${stamp}`, md, {
          source: ex.source,
          missingTables: ex.missingTables,
          rejects: [...ex.rejects, ...t.rejects],
          warnings: t.warnings,
          excludedByWindow: t.excludedByWindow,
          cutoff: t.cutoff,
          targetRows: Object.fromEntries(TARGETS.map((n) => [n, t.rows[n].length])),
          load: loadReport,
        });
        io.err(`report: ${files.join(', ')}`);
        return 0;
      }

      if (command === 'load') {
        io.out(summary);
        if ((rejectCount > 0 || ex.missingTables.length > 0) && !values['accept-rejects']) {
          io.err(
            `refusing to load: ${rejectCount} rejected row(s), ${ex.missingTables.length} missing table(s). ` +
              'Fix the mapping (see `inspect`) or re-run with --accept-rejects after QA review.',
          );
          return 2;
        }
        const r = await runLoad(client!, t, ctx, { dryRun: false });
        const lr = renderLoad(r);
        io.out(`\n${lr}`);
        const files = writeReport(
          reportDir,
          `load-${stamp}`,
          `# Migration load\n\n${summary}\n\n${lr}\n`,
          r,
        );
        io.err(`report: ${files.join(', ')}`);
        return 0;
      }

      // verify
      const r = await runVerify(client!, t, {
        source: ex.source,
        rejects: ex.rejects,
        missingTables: ex.missingTables,
        now,
      });
      const md = renderVerify(r);
      io.out(md);
      const files = writeReport(reportDir, `verify-${stamp}`, md, r);
      io.err(`report: ${files.join(', ')}`);
      return r.ok ? 0 : 1;
    } finally {
      if (client) await client.end();
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 64;
    }
    // Error messages from this tool carry ids/counts only; pg errors may quote values, so only
    // their code and constraint are shown.
    const pgErr = e as { code?: string; constraint?: string; table?: string };
    if (pgErr.code) {
      io.err(
        `database error ${pgErr.code}${pgErr.table ? ` on ${pgErr.table}` : ''}${pgErr.constraint ? ` (${pgErr.constraint})` : ''}`,
      );
    } else {
      io.err(`error: ${(e as Error).message}`);
    }
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`fatal: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
