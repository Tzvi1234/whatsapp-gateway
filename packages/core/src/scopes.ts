/** Legacy v1 scopes (WhatsApp-Automation agent tokens). */
export const LEGACY_SCOPES = [
  'automations:read',
  'automations:write',
  'messages:send',
  'reminders:send',
  'threads:read',
  'sessions:read',
  'sessions:write',
] as const;

export const SCOPES = [
  ...LEGACY_SCOPES,
  'media:send',
  'templates:send',
  'groups:read',
  'groups:send',
  'accounts:read',
  /** Relay keys (e.g. Lia) — must be bound to non-empty conversation_ids. */
  'relay',
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
}

/** The key alias every legacy (account-less) MCP call resolves to. */
export const LEGACY_ACCOUNT_ALIASES = { baileys: 'default', meta_cloud: 'meta-default' } as const;
