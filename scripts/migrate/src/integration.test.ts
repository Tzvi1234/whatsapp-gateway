/**
 * End-to-end against a real Postgres with supabase/migrations applied.
 * Runs only when MIGRATE_TEST_DATABASE_URL is set (superuser / service connection).
 * Each run uses a fresh random org + account ids, so it can be re-run on the same database.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type Io } from './cli';
import { extract, openLegacyDb, type Extracted } from './extract';
import { probeLegacyKeyPrefix, runLoad, type LoadContext } from './load';
import { buildFixture, FIXTURE_NOW, SENSITIVE } from './test-fixture';
import { targetId, transform, type TransformResult } from './transform';
import { runVerify } from './verify';

const url = process.env.MIGRATE_TEST_DATABASE_URL;

describe.skipIf(!url)('integration (MIGRATE_TEST_DATABASE_URL)', () => {
  const org = randomUUID();
  const baileys = randomUUID();
  const cloud = randomUUID();
  let fx: { dir: string; path: string };
  let client: pg.Client;
  let ex: Extracted;
  let t: TransformResult;
  let ctx: LoadContext;

  const quiet = (): Io & { out_: string[] } => {
    const out_: string[] = [];
    return { out_, out: (s) => out_.push(s), err: (s) => out_.push(s), env: {} };
  };
  const args = (cmd: string, extra: string[] = []) => [
    cmd,
    '--sqlite',
    fx.path,
    '--database-url',
    url!,
    '--org',
    org,
    '--baileys-account',
    baileys,
    '--cloud-account',
    cloud,
    '--now',
    FIXTURE_NOW.toISOString(),
    '--report-dir',
    fx.dir,
    ...extra,
  ];
  const verify = () =>
    runVerify(client, t, {
      source: ex.source,
      rejects: ex.rejects,
      missingTables: [],
      now: FIXTURE_NOW,
    });
  const changes = (r: { tables: { inserted: number; updated: number }[] }) =>
    r.tables.reduce((n, x) => n + x.inserted + x.updated, 0);

  beforeAll(async () => {
    fx = buildFixture({ reminderUuid: randomUUID() });
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('insert into public.orgs (id, name) values ($1, $2)', [org, 'migrate test']);
    const db = openLegacyDb(fx.path);
    ex = extract(db, fx.path);
    db.close();
    t = transform(ex.data, {
      orgId: org,
      baileysAccountId: baileys,
      cloudAccountId: cloud,
      sinceDays: 30,
      now: FIXTURE_NOW,
      legacyKeyPrefix: await probeLegacyKeyPrefix(client),
    });
    ctx = { orgId: org, baileysAccountId: baileys, cloudAccountId: cloud, auditMeta: {} };
  });

  afterAll(async () => {
    await client?.end();
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
  });

  it('M1: load refuses to run while there are rejects (never silently dropped)', async () => {
    const io = quiet();
    expect(await main(args('load'), io)).toBe(2);
    const n = await client.query(
      'select count(*)::int as n from public.automations where org_id = $1',
      [org],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('M1: dry-run plan writes nothing', async () => {
    const io = quiet();
    expect(await main(args('plan'), io)).toBe(0);
    const text = io.out_.join('\n');
    expect(text).toContain('Plan (dry run, rolled back)');
    for (const s of SENSITIVE) expect(text).not.toContain(s);
    const n = await client.query(
      'select count(*)::int as n from public.accounts where org_id = $1',
      [org],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('M1: first load inserts everything, second load changes nothing', async () => {
    const io = quiet();
    expect(await main(args('load', ['--accept-rejects']), io)).toBe(0);
    for (const s of SENSITIVE) expect(io.out_.join('\n')).not.toContain(s);

    const second = await runLoad(client, t, ctx, { dryRun: false });
    expect(changes(second)).toBe(0);
    for (const x of second.tables) expect(x.unchanged).toBe(x.rows);

    const third = await runLoad(client, t, ctx, { dryRun: true });
    expect(changes(third)).toBe(0);
  });

  it('M2: verify reports no differences and the CLI exits 0', async () => {
    const r = await verify();
    expect(r.ok).toBe(true);
    for (const x of r.tables) {
      expect(x.matched).toBe(x.sourceCount);
      expect(x.sourceDigest).toBe(x.targetDigest);
    }
    expect(r.tables.find((x) => x.name === 'messages')!.sourceCount).toBe(4);
    const io = quiet();
    expect(await main(args('verify'), io)).toBe(0);
    for (const s of SENSITIVE) expect(io.out_.join('\n')).not.toContain(s);
  });

  it('M4: reminders keep ids and state (unconfigured stays retryable)', async () => {
    const r = await client.query<{ id: string; state: string; legacy_id: string }>(
      'select id::text, state, legacy_id from public.reminders where org_id = $1 order by legacy_id',
      [org],
    );
    const byLegacy = new Map(r.rows.map((x) => [x.legacy_id, x]));
    const uuidRow = r.rows.find((x) => x.state === 'unconfigured')!;
    expect(uuidRow.id).toBe(uuidRow.legacy_id.toLowerCase());
    expect(byLegacy.get('r-legacy-2')).toMatchObject({
      id: targetId(org, 'reminders', 'r-legacy-2'),
      state: 'scheduled',
    });
  });

  it('M1: legacy api_clients carry the 7 legacy scopes, legacy=true and the hash', async () => {
    const r = await client.query<{ scopes: string[]; legacy: boolean; key_prefix: string | null }>(
      'select scopes, legacy, key_prefix from public.api_clients where org_id = $1',
      [org],
    );
    expect(r.rows).toHaveLength(2);
    for (const x of r.rows) {
      expect(x.scopes).toHaveLength(7);
      expect(x.legacy).toBe(true);
      expect(x.key_prefix === null || x.key_prefix.startsWith('legacy-')).toBe(true);
    }
  });

  it('M2: tampering is detected by id + column, and a re-load repairs it', async () => {
    const a1 = targetId(org, 'automations', 1);
    const m1 = targetId(org, 'chat_messages', 1);
    await client.query("update public.automations set name = 'tampered' where id = $1", [a1]);
    await client.query('delete from public.messages where id = $1', [m1]);
    const bad = await verify();
    expect(bad.ok).toBe(false);
    expect(bad.tables.find((x) => x.name === 'automations')!.mismatched).toEqual([
      { id: a1, columns: ['name'] },
    ]);
    expect(bad.tables.find((x) => x.name === 'messages')!.missing).toEqual([m1]);
    const io = quiet();
    expect(await main(args('verify'), io)).toBe(1);

    const repair = await runLoad(client, t, ctx, { dryRun: false });
    const by = new Map(repair.tables.map((x) => [x.name, x]));
    expect(by.get('automations')).toMatchObject({ updated: 1, inserted: 0 });
    expect(by.get('messages')).toMatchObject({ updated: 0, inserted: 1 });
    expect(changes(repair)).toBe(2);
    expect((await verify()).ok).toBe(true);
  });

  it('M1: every real load appends one audit_log row; the chain stays valid', async () => {
    const r = await client.query<{ n: number }>(
      "select count(*)::int as n from public.audit_log where org_id = $1 and action = 'legacy_migration.load'",
      [org],
    );
    expect(r.rows[0]!.n).toBe(3);
    const chain = await client.query<{ ok: boolean }>('select ok from public.audit_verify_chain()');
    expect(chain.rows[0]!.ok).toBe(true);
  });

  it('M1: preflight aborts before writing when an account id has the wrong provider', async () => {
    const swapped = { ...ctx, baileysAccountId: cloud, cloudAccountId: baileys };
    const t2 = transform(ex.data, {
      orgId: org,
      baileysAccountId: cloud,
      cloudAccountId: baileys,
      sinceDays: 30,
      now: FIXTURE_NOW,
      legacyKeyPrefix: 'null',
    });
    await expect(runLoad(client, t2, swapped, { dryRun: false })).rejects.toThrow(
      /preflight failed/,
    );
  });
});
