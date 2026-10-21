import { describe, expect, it } from 'vitest';
import { canonicalJson, normalizeTimestamp, rowHash, sha256Hex } from './canonical';
import { TABLE_SPECS, verifiedColumns } from './tables';
import { diffTable } from './verify';

describe('canonical hashing', () => {
  it('M2: canonical JSON sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ x: undefined, y: 1 })).toBe('{"y":1}');
  });

  it('M2: timestamps normalise across Date, ISO-with-offset and ms', () => {
    const iso = '2026-10-21T12:00:00.123Z';
    expect(normalizeTimestamp(new Date(iso))).toBe(iso);
    expect(normalizeTimestamp('2026-10-21T15:00:00.123+03:00')).toBe(iso);
    expect(normalizeTimestamp('2026-10-21T12:00:00.123+00:00')).toBe(iso);
    expect(normalizeTimestamp(Date.parse(iso))).toBe(iso);
  });

  it('M2: row hash is stable across representations and changes when a value changes', () => {
    const cols = verifiedColumns(TABLE_SPECS.automation_cooldowns);
    const src = {
      id: 'AAAAAAAA-0000-4000-8000-000000000001',
      org_id: '00000000-0000-4000-8000-000000000001',
      account_id: '11111111-1111-4111-8111-111111111111',
      automation_id: null,
      status_id: null,
      provider_status_id: 'S1',
      contact_key: '1@lid',
      replied_at: '2026-10-21T12:00:00.000Z',
      __rowid: 3,
    };
    const fromDb = {
      ...src,
      id: src.id.toLowerCase(),
      replied_at: '2026-10-21T14:00:00+02:00',
    };
    expect(rowHash(src, cols)).toBe(rowHash(fromDb, cols));
    expect(rowHash(src, cols)).not.toBe(rowHash({ ...fromDb, contact_key: '2@lid' }, cols));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('M2: diffTable reports missing and mismatched ids with column names only', () => {
    const spec = TABLE_SPECS.statuses;
    const row = (id: string, caption: string | null) => ({
      __rowid: 1,
      id,
      org_id: 'o',
      account_id: 'a',
      provider_status_id: `p${id}`,
      kind: 'text',
      caption,
      media_path: null,
      posted_at: '2026-10-21T12:00:00.000Z',
      expires_at: null,
      legacy_id: id,
      created_at: '2026-10-21T12:00:00.000Z',
    });
    const source = [row('1', 'x'), row('2', 'y'), row('3', 'z')];
    const target = [row('1', 'x'), row('2', 'CHANGED')];
    const d = diffTable(spec, source, target);
    expect(d).toMatchObject({ sourceCount: 3, targetCount: 2, matched: 1, missing: ['3'] });
    expect(d.mismatched).toEqual([{ id: '2', columns: ['caption'] }]);
    expect(JSON.stringify(d)).not.toContain('CHANGED');
    expect(d.sourceDigest).not.toBe(d.targetDigest);

    const clean = diffTable(spec, source, source);
    expect(clean.matched).toBe(3);
    expect(clean.sourceDigest).toBe(clean.targetDigest);
  });
});
