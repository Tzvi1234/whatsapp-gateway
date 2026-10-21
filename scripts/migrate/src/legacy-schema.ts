/**
 * ASSUMED schema of the legacy WhatsApp-Automation SQLite database
 * (`data/whatsapp-automation.sqlite` on htz-home-01).
 *
 * The legacy repository is NOT available to us, so everything in this file is an explicit,
 * documented assumption derived from ARCHITECTURE.md §9.3 and the behaviour we must preserve.
 * Before any real migration, run `migrate inspect --sqlite <path>` on the server (read-only):
 * it prints the REAL tables/columns/row counts and a diff against this file. Adjust the column
 * names here (and the zod schemas below) until the diff is empty, then `plan`.
 *
 * Conventions assumed:
 *  - every timestamp is an INTEGER of milliseconds since the Unix epoch (UTC). `inspect` reports,
 *    per timestamp column, how many values look like seconds instead of milliseconds;
 *  - booleans are INTEGER 0/1;
 *  - list-valued columns (keywords, options, template params, scopes) are JSON text;
 *  - `slot` is the legacy session slot id: `default` (Baileys) or `meta-default` (Cloud API).
 *
 * Rows that fail validation are reported by table + rowid (never their contents) and are never
 * silently dropped: `load` refuses to run while there are rejects unless `--accept-rejects`.
 */
import { z } from 'zod';

export const LEGACY_TABLES = [
  'linked_accounts',
  'settings',
  'statuses',
  'automations',
  'cooldowns',
  'contact_aliases',
  'reminders',
  'agent_tokens',
  'chat_messages',
] as const;
export type LegacyTable = (typeof LEGACY_TABLES)[number];

export interface AssumedColumn {
  type: 'INTEGER' | 'TEXT';
  nullable: boolean;
  /** ms-epoch timestamp (inspect checks the magnitude). */
  ts?: boolean;
  /** Small categorical column: inspect prints value -> count (values truncated, never free text). */
  enumLike?: boolean;
  note?: string;
}

export interface AssumedTable {
  description: string;
  /** Primary key column. */
  pk: string;
  columns: Record<string, AssumedColumn>;
}

const int = (nullable = false, extra: Partial<AssumedColumn> = {}): AssumedColumn => ({
  type: 'INTEGER',
  nullable,
  ...extra,
});
const text = (nullable = false, extra: Partial<AssumedColumn> = {}): AssumedColumn => ({
  type: 'TEXT',
  nullable,
  ...extra,
});
const ts = (nullable = false): AssumedColumn => int(nullable, { ts: true });
const slot = (): AssumedColumn =>
  text(true, { enumLike: true, note: "'default' | 'meta-default' (null = table default)" });

export const ASSUMED_SCHEMA: Record<LegacyTable, AssumedTable> = {
  linked_accounts: {
    description: 'Session slots (sessions/registry). -> accounts (alias = slot id)',
    pk: 'id',
    columns: {
      id: text(false, { enumLike: true, note: "slot id: 'default' | 'meta-default'" }),
      kind: text(false, { enumLike: true, note: "'baileys' | 'meta'" }),
      label: text(true),
      phone: text(true, { note: 'any Israeli format, normalised with toE164' }),
      created_at: ts(),
    },
  },
  settings: {
    description: 'Global key/value settings. Known keys -> accounts.pacing of the Baileys account',
    pk: 'key',
    columns: {
      key: text(false, {
        enumLike: true,
        note: 'daily_cap | min_delay_ms | max_delay_ms | timezone (others reported as unmapped)',
      }),
      value: text(true),
    },
  },
  statuses: {
    description: 'Posted WhatsApp statuses that automations bind to. -> statuses',
    pk: 'id',
    columns: {
      id: int(),
      slot: slot(),
      wa_status_id: text(false, { note: 'provider status (message) id' }),
      kind: text(true, { enumLike: true }),
      caption: text(true),
      media_path: text(true),
      posted_at: ts(),
      expires_at: ts(true),
    },
  },
  automations: {
    description: 'Status-reply automations. -> automations',
    pk: 'id',
    columns: {
      id: int(),
      slot: slot(),
      name: text(),
      enabled: int(false, { note: '0/1' }),
      bind_mode: text(false, { enumLike: true, note: "'status' | 'next_status'" }),
      status_id: int(true, { note: 'statuses.id' }),
      keywords: text(false, { note: 'JSON string[]' }),
      match_mode: text(false, { enumLike: true, note: "'exact' | 'contains'" }),
      case_sensitive: int(false, { note: '0/1' }),
      ignore_emoji: int(false, { note: '0/1' }),
      reply_text: text(true),
      reply_media_path: text(true),
      options: text(true, { note: 'JSON string[] (<= 10)' }),
      try_native_buttons: int(false, { note: '0/1' }),
      daily_cap: int(true),
      max_age_sec: int(true, { note: 'default 300' }),
      created_at: ts(),
      updated_at: ts(),
    },
  },
  cooldowns: {
    description: 'One reply per contact per status. -> automation_cooldowns',
    pk: 'id',
    columns: {
      id: int(),
      slot: slot(),
      automation_id: int(true),
      status_id: int(true),
      wa_status_id: text(),
      contact_jid: text(false, { note: 'PN or LID JID (normalised as contact_key)' }),
      replied_at: ts(),
    },
  },
  contact_aliases: {
    description: 'Display names per contact JID. -> contacts',
    pk: 'id',
    columns: {
      id: int(),
      slot: slot(),
      jid: text(false, { note: 'PN JID, LID JID or phone number' }),
      alias: text(),
      created_at: ts(),
      updated_at: ts(),
    },
  },
  reminders: {
    description:
      'Cloud API reminders. -> reminders (ids kept when they are UUIDs; non-terminal + last N days)',
    pk: 'id',
    columns: {
      id: text(false, { note: 'UUID kept as target id; otherwise deterministic id + legacy_id' }),
      slot: slot(),
      to_phone: text(),
      body: text(true),
      template_name: text(true),
      template_language: text(true),
      template_params: text(true, { note: 'JSON array' }),
      due_at: ts(),
      state: text(false, { enumLike: true }),
      attempts: int(),
      error_code: text(true, { enumLike: true }),
      created_at: ts(),
      updated_at: ts(),
      cancelled_at: ts(true),
    },
  },
  agent_tokens: {
    description: 'MCP agent tokens, SHA-256 hashes only. -> api_clients (legacy = true)',
    pk: 'id',
    columns: {
      id: int(),
      name: text(true),
      token_hash: text(false, { note: 'lowercase hex SHA-256 of the whole token' }),
      scopes: text(true, { note: 'ignored: legacy tokens get all 7 legacy scopes' }),
      created_at: ts(),
      last_used_at: ts(true),
      revoked_at: ts(true),
    },
  },
  chat_messages: {
    description: 'Chat history. -> conversations + messages (last N days)',
    pk: 'id',
    columns: {
      id: int(),
      slot: slot(),
      chat_jid: text(),
      wa_message_id: text(),
      from_me: int(false, { note: '0/1' }),
      sender_jid: text(true),
      push_name: text(true),
      type: text(false, { enumLike: true }),
      body: text(true),
      media_path: text(true),
      media_mime: text(true, { enumLike: true }),
      status: text(true, { enumLike: true }),
      timestamp: ts(),
    },
  },
};

/** DDL for the assumed schema (used by tests to build fixtures; documents the assumption). */
export function assumedDdl(): string {
  return LEGACY_TABLES.map((t) => {
    const spec = ASSUMED_SCHEMA[t];
    const cols = Object.entries(spec.columns).map(([name, c]) => {
      const pk = name === spec.pk ? ' PRIMARY KEY' : '';
      const nn = c.nullable || pk ? '' : ' NOT NULL';
      return `  ${name} ${c.type}${pk}${nn}`;
    });
    return `CREATE TABLE ${t} (\n${cols.join(',\n')}\n);`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// zod validation of source rows
// ---------------------------------------------------------------------------

/** 2015-01-01 .. 2100-01-01 in ms: catches second-based epochs and garbage. */
const MS_MIN = 1_420_070_400_000;
const MS_MAX = 4_102_444_800_000;
const msEpoch = z
  .number()
  .int()
  .refine((n) => n >= MS_MIN && n < MS_MAX, { message: 'not_ms_epoch' });
const bool01 = z.union([z.literal(0), z.literal(1)]).transform((v) => v === 1);
const slotCol = z.enum(['default', 'meta-default']).nullable();
const nonEmpty = z.string().min(1);

/** JSON text holding an array of strings. */
const jsonStringArray = z.string().transform((s, ctx): string[] => {
  try {
    const v: unknown = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    // fallthrough
  }
  ctx.addIssue({ code: 'custom', message: 'invalid_json_string_array' });
  return z.NEVER;
});
const jsonArray = z.string().transform((s, ctx): unknown[] => {
  try {
    const v: unknown = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch {
    // fallthrough
  }
  ctx.addIssue({ code: 'custom', message: 'invalid_json_array' });
  return z.NEVER;
});

export const LEGACY_REMINDER_STATES = [
  'pending',
  'scheduled',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'unconfigured',
  'cancelled',
] as const;

export const legacyRowSchemas = {
  linked_accounts: z.object({
    id: z.enum(['default', 'meta-default']),
    kind: z.enum(['baileys', 'meta']),
    label: z.string().nullable(),
    phone: z.string().nullable(),
    created_at: msEpoch,
  }),
  settings: z.object({
    key: nonEmpty,
    value: z.string().nullable(),
  }),
  statuses: z.object({
    id: z.number().int(),
    slot: slotCol,
    wa_status_id: nonEmpty,
    kind: z.string().nullable(),
    caption: z.string().nullable(),
    media_path: z.string().nullable(),
    posted_at: msEpoch,
    expires_at: msEpoch.nullable(),
  }),
  automations: z.object({
    id: z.number().int(),
    slot: slotCol,
    name: nonEmpty,
    enabled: bool01,
    bind_mode: z.enum(['status', 'next_status']),
    status_id: z.number().int().nullable(),
    keywords: jsonStringArray,
    match_mode: z.enum(['exact', 'contains']),
    case_sensitive: bool01,
    ignore_emoji: bool01,
    reply_text: z.string().nullable(),
    reply_media_path: z.string().nullable(),
    options: jsonStringArray
      .refine((a) => a.length <= 10, { message: 'more_than_10_options' })
      .nullable(),
    try_native_buttons: bool01,
    daily_cap: z.number().int().min(0).nullable(),
    max_age_sec: z.number().int().min(0).nullable(),
    created_at: msEpoch,
    updated_at: msEpoch,
  }),
  cooldowns: z.object({
    id: z.number().int(),
    slot: slotCol,
    automation_id: z.number().int().nullable(),
    status_id: z.number().int().nullable(),
    wa_status_id: nonEmpty,
    contact_jid: nonEmpty,
    replied_at: msEpoch,
  }),
  contact_aliases: z.object({
    id: z.number().int(),
    slot: slotCol,
    jid: nonEmpty,
    alias: z.string(),
    created_at: msEpoch,
    updated_at: msEpoch,
  }),
  reminders: z.object({
    id: nonEmpty,
    slot: slotCol,
    to_phone: nonEmpty,
    body: z.string().nullable(),
    template_name: z.string().nullable(),
    template_language: z.string().nullable(),
    template_params: jsonArray.nullable(),
    due_at: msEpoch,
    state: z.enum(LEGACY_REMINDER_STATES),
    attempts: z.number().int().min(0),
    error_code: z.string().nullable(),
    created_at: msEpoch,
    updated_at: msEpoch,
    cancelled_at: msEpoch.nullable(),
  }),
  agent_tokens: z.object({
    id: z.number().int(),
    name: z.string().nullable(),
    token_hash: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, { message: 'not_sha256_hex' })
      .transform((s) => s.toLowerCase()),
    scopes: z.string().nullable(),
    created_at: msEpoch,
    last_used_at: msEpoch.nullable(),
    revoked_at: msEpoch.nullable(),
  }),
  chat_messages: z.object({
    id: z.number().int(),
    slot: slotCol,
    chat_jid: nonEmpty,
    wa_message_id: nonEmpty,
    from_me: bool01,
    sender_jid: z.string().nullable(),
    push_name: z.string().nullable(),
    type: nonEmpty,
    body: z.string().nullable(),
    media_path: z.string().nullable(),
    media_mime: z.string().nullable(),
    status: z.string().nullable(),
    timestamp: msEpoch,
  }),
} satisfies Record<LegacyTable, z.ZodType>;

export type LegacyRow<T extends LegacyTable> = z.output<(typeof legacyRowSchemas)[T]> & {
  /** SQLite rowid (for reports). */
  __rowid: number;
};

export type LegacyData = { [T in LegacyTable]: LegacyRow<T>[] };
