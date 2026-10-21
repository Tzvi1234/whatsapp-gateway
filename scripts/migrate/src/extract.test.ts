import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type Io } from './cli';
import { extract, fileFingerprint, openLegacyDb } from './extract';
import { inspectDb, renderInspect } from './inspect';
import { BAILEYS, buildFixture, CLOUD, ORG, SENSITIVE } from './test-fixture';

const dirs: string[] = [];
const fixture = (omit?: string[]) => {
  const f = buildFixture(omit ? { omit } : {});
  dirs.push(f.dir);
  return f;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    env: {},
  };
}

describe('extract / inspect (read-only)', () => {
  it('M1: the SQLite file is opened read-only and never modified', () => {
    const { path } = fixture();
    const before = fileFingerprint(path);
    const db = openLegacyDb(path);
    expect(() => db.exec('DELETE FROM settings')).toThrow();
    extract(db, path);
    inspectDb(db);
    db.close();
    expect(fileFingerprint(path)).toEqual(before);
  });

  it('M1: refuses a missing file instead of creating one', () => {
    expect(() => openLegacyDb('/nonexistent/dir/legacy.sqlite')).toThrow();
  });

  it('M2: missing legacy tables are reported, not silently skipped', () => {
    const { path } = fixture(['cooldowns']);
    const db = openLegacyDb(path);
    const ex = extract(db, path);
    db.close();
    expect(ex.missingTables).toEqual(['cooldowns']);
  });

  it('M2: inspect prints schema, counts and diffs but no row contents', () => {
    const { path } = fixture();
    const raw = new Database(path);
    raw.exec('ALTER TABLE statuses ADD COLUMN extra_col TEXT');
    raw.close();
    const db2 = openLegacyDb(path);
    const r = inspectDb(db2);
    db2.close();
    const st = r.tables.find((t) => t.name === 'statuses')!;
    expect(st.rowCount).toBe(2);
    expect(st.extraColumns).toEqual(['extra_col']);
    const cm = r.tables.find((t) => t.name === 'chat_messages')!;
    expect(cm.timestampMagnitudes.timestamp).toEqual({ ms: 6, seconds: 1, other: 0, nulls: 0 });
    expect(cm.categorical.type!.values).toEqual({ text: 6, ptt: 1 });
    const text = renderInspect(r) + JSON.stringify(r);
    for (const s of SENSITIVE) expect(text).not.toContain(s);
  });
});

describe('cli', () => {
  it('M2: offline plan prints counts and rejects, never bodies, phones or tokens', async () => {
    const { path, dir } = fixture();
    const io = capture();
    const code = await main(
      [
        'plan',
        '--sqlite',
        path,
        '--org',
        ORG,
        '--baileys-account',
        BAILEYS,
        '--cloud-account',
        CLOUD,
        '--now',
        '2026-10-21T12:00:00Z',
        '--report-dir',
        dir,
      ],
      io,
    );
    expect(code).toBe(0);
    const text = io.stdout.join('\n') + io.stderr.join('\n');
    expect(text).toContain('| messages | 4 |');
    expect(text).toContain('chat_messages rowid 6: invalid:timestamp:not_ms_epoch');
    for (const s of SENSITIVE) expect(text).not.toContain(s);
  });

  it('M1: load and verify require a database url; bad args are usage errors', async () => {
    const { path } = fixture();
    const base = ['--sqlite', path, '--org', ORG, '--baileys-account', BAILEYS];
    expect(await main(['load', ...base, '--cloud-account', CLOUD], capture())).toBe(64);
    expect(await main(['verify', ...base, '--cloud-account', BAILEYS], capture())).toBe(64);
    expect(await main(['plan', ...base, '--cloud-account', 'nope'], capture())).toBe(64);
    expect(await main(['bogus'], capture())).toBe(64);
  });
});
