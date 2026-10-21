/**
 * Canonical JSON + SHA-256 used by the diff report (TEST-PLAN M2). Both sides (transformed source
 * rows and rows read back from Postgres) go through the same column-typed normaliser, so the
 * hash only differs when a value really differs.
 */
import { createHash } from 'node:crypto';

export type ColType =
  'uuid' | 'text' | 'bool' | 'int' | 'timestamptz' | 'jsonb' | 'text[]' | 'uuid[]';

/** Timestamps -> `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, ms precision). */
export function normalizeTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v) : new Date(String(v));
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new Error('invalid timestamp');
  return d.toISOString();
}

function normalizeNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error('invalid number');
  return Object.is(n, -0) ? 0 : n;
}

/** Recursively normalises plain JSON (numbers, -0, undefined -> dropped in objects). */
function normalizeJson(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return normalizeNumber(v);
  if (Array.isArray(v)) return v.map(normalizeJson);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = normalizeJson(x);
    }
    return out;
  }
  return v;
}

export function normalizeValue(type: ColType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'uuid':
      return String(v).toLowerCase();
    case 'text':
      return String(v);
    case 'bool':
      return v === true || v === 't' || v === 'true' || v === 1;
    case 'int':
      return normalizeNumber(v);
    case 'timestamptz':
      return normalizeTimestamp(v);
    case 'jsonb':
      return normalizeJson(typeof v === 'string' ? JSON.parse(v) : v);
    case 'text[]':
      return (v as unknown[]).map((x) => (x === null ? null : String(x)));
    case 'uuid[]':
      return (v as unknown[]).map((x) => (x === null ? null : String(x).toLowerCase()));
  }
}

/** JSON with object keys sorted recursively (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  return JSON.stringify(v);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Projects `row` onto `columns`, normalising each value by its type. */
export function project(
  row: Record<string, unknown>,
  columns: readonly { name: string; type: ColType }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c.name] = normalizeValue(c.type, row[c.name]);
  return out;
}

export function rowHash(
  row: Record<string, unknown>,
  columns: readonly { name: string; type: ColType }[],
): string {
  return sha256Hex(canonicalJson(project(row, columns)));
}
