import { createHash } from 'node:crypto';

/** Truncated sha256 for log-safe jid identifiers (never log full JIDs). */
export function hashId(value: string, len = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, len);
}

export function jidKind(jid: string | undefined | null): 'lid' | 'pn' | 'group' | 'other' {
  if (!jid) return 'other';
  if (jid.endsWith('@lid') || jid.includes('@hosted.lid')) return 'lid';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return 'pn';
  if (jid.endsWith('@g.us')) return 'group';
  return 'other';
}
