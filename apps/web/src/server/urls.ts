import { env } from './env';

export const META_WEBHOOK_PATH = '/api/meta/webhook';
export const MCP_PATH = '/mcp';

/** The Meta webhook URL shown (and copied) on the connect screen. Built only from PUBLIC_BASE_URL (C6). */
export function metaWebhookUrl(): string {
  return `${env().PUBLIC_BASE_URL}${META_WEBHOOK_PATH}`;
}

/** The MCP endpoint URL agents configure. */
export function mcpUrl(): string {
  return `${env().PUBLIC_BASE_URL}${MCP_PATH}`;
}

/**
 * Canonical form for URL comparison: lower-case scheme and host, default port dropped,
 * trailing slashes removed from the path, query/fragment ignored. Unparseable → trimmed input.
 */
export function normalizeUrlForCompare(raw: string): string {
  const s = raw.trim();
  try {
    const u = new URL(s);
    const port = u.port && !(u.protocol === 'https:' && u.port === '443') ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${path}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

/**
 * C15 banner "הכתובת השתנתה, עדכן ב-Meta": true when the URL saved at webhook verification
 * differs from the current `metaWebhookUrl()` after normalisation. Never shown before any
 * verification (`verifiedUrl` null/empty → false).
 */
export function webhookUrlChanged(
  verifiedUrl: string | null | undefined,
  current: string = metaWebhookUrl(),
): boolean {
  if (!verifiedUrl || !verifiedUrl.trim()) return false;
  return normalizeUrlForCompare(verifiedUrl) !== normalizeUrlForCompare(current);
}
