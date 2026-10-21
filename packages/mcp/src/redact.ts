import { createHash } from 'node:crypto';

/** Args whose content is message body / personal text: stored as hash + length only. */
const BODY_KEYS = new Set(['text', 'caption', 'reply_text', 'keyword', 'params', 'options']);
/** Args that are phone numbers / chat ids: masked to the last 4 characters. */
const PHONE_KEYS = new Set(['to', 'chat', 'group']);
const URL_KEYS = new Set(['url', 'media_url']);

function digest(v: unknown): { sha256: string; len: number } {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return {
    sha256: createHash('sha256')
      .update(s ?? '')
      .digest('hex')
      .slice(0, 16),
    len: s?.length ?? 0,
  };
}

function maskChat(v: unknown): string {
  if (typeof v !== 'string') return '***';
  const user = v.split('@')[0] ?? '';
  const digits = user.replace(/\D/g, '');
  const suffix = v.includes('@') ? `@${v.split('@').pop()}` : '';
  return digits.length <= 4 ? `***${suffix}` : `…${digits.slice(-4)}${suffix}`;
}

function urlOrigin(v: unknown): string {
  if (typeof v !== 'string') return '***';
  try {
    return new URL(v).origin;
  } catch {
    return '***';
  }
}

/** Redacts tool args for `audit_log.meta` (bodies hashed, numbers masked). */
export function redactArgs(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (BODY_KEYS.has(k)) out[k] = digest(v);
    else if (PHONE_KEYS.has(k)) out[k] = maskChat(v);
    else if (URL_KEYS.has(k)) out[k] = urlOrigin(v);
    else if (k === 'template' && v && typeof v === 'object') {
      const t = v as { name?: unknown; language?: unknown; params?: unknown };
      out[k] = { name: t.name, language: t.language, params: digest(t.params ?? []) };
    } else if (Array.isArray(v)) out[k] = { count: v.length };
    else if (typeof v === 'string') out[k] = v.length > 128 ? `${v.slice(0, 128)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = '[object]';
  }
  return out;
}
