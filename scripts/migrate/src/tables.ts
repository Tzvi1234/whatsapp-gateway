/**
 * Target-table specs (supabase/migrations/*.sql) shared by load and verify, in load (FK) order.
 *
 *  - `columns`: written on insert. `verify: false` columns are NOT part of the M2 hash
 *    (`insertOnly` ones are written once and then owned by the runtime, e.g. `updated_at`
 *    which a trigger rewrites, or `last_used_at`).
 *  - `mode: 'update'` (account_settings) only updates existing rows by id.
 *  - `naturalKeys`: unique constraints other than the PK. Duplicates in the source are rejected
 *    by the transform, and a pre-existing target row with the same natural key but a different
 *    id aborts the load (it would otherwise fail with a unique violation half way).
 */
import type { ColType } from './canonical';

export interface ColumnSpec {
  name: string;
  type: ColType;
  /** Written on insert only, never updated, not verified. */
  insertOnly?: boolean;
}

export interface NaturalKeySpec {
  name: string;
  /** SQL expression over the target table producing the key as text (alias-free columns). */
  sql: string;
  /** Same key computed from a transformed row; null = no key (e.g. a null column). */
  fromRow: (row: Record<string, unknown>) => string | null;
}

export interface TableSpec {
  /** Report name. */
  name: TargetName;
  /** Physical table in schema public. */
  table: string;
  /** Legacy source table(s), for the report. */
  source: string;
  mode: 'upsert' | 'update';
  columns: ColumnSpec[];
  naturalKeys: NaturalKeySpec[];
}

export const TARGETS = [
  'accounts',
  'account_settings',
  'statuses',
  'automations',
  'automation_cooldowns',
  'contacts',
  'api_clients',
  'conversations',
  'messages',
  'reminders',
] as const;
export type TargetName = (typeof TARGETS)[number];

const SEP = '\u0001';
const key = (...parts: unknown[]): string | null =>
  parts.some((p) => p === null || p === undefined) ? null : parts.map(String).join(SEP);
/** Null-propagating (unlike concat_ws), matching `key()`. */
const keySql = (...exprs: string[]) => `(${exprs.join(' || chr(1) || ')})`;

const c = (name: string, type: ColType, insertOnly = false): ColumnSpec =>
  insertOnly ? { name, type, insertOnly } : { name, type };

export const TABLE_SPECS: Record<TargetName, TableSpec> = {
  accounts: {
    name: 'accounts',
    table: 'accounts',
    source: 'linked_accounts',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('provider', 'text'),
      c('alias', 'text'),
      // Existing accounts (created in the connect screen) keep their label / phone.
      c('label', 'text', true),
      c('phone_e164', 'text', true),
    ],
    naturalKeys: [
      {
        name: 'org_alias',
        sql: keySql('org_id::text', 'alias'),
        fromRow: (r) => key(r.org_id, r.alias),
      },
    ],
  },
  account_settings: {
    name: 'account_settings',
    table: 'accounts',
    source: 'settings',
    mode: 'update',
    columns: [c('id', 'uuid'), c('pacing', 'jsonb')],
    naturalKeys: [],
  },
  statuses: {
    name: 'statuses',
    table: 'statuses',
    source: 'statuses',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('provider_status_id', 'text'),
      c('kind', 'text'),
      c('caption', 'text'),
      c('media_path', 'text'),
      c('posted_at', 'timestamptz'),
      c('expires_at', 'timestamptz'),
      c('legacy_id', 'text'),
      c('created_at', 'timestamptz'),
    ],
    naturalKeys: [
      {
        name: 'account_status',
        sql: keySql('account_id::text', 'provider_status_id'),
        fromRow: (r) => key(r.account_id, r.provider_status_id),
      },
    ],
  },
  automations: {
    name: 'automations',
    table: 'automations',
    source: 'automations',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('name', 'text'),
      c('enabled', 'bool'),
      c('bind_mode', 'text'),
      c('status_id', 'uuid'),
      c('keywords', 'text[]'),
      c('match_mode', 'text'),
      c('case_sensitive', 'bool'),
      c('ignore_emoji', 'bool'),
      c('reply_text', 'text'),
      c('reply_media_path', 'text'),
      c('options', 'text[]'),
      c('try_native_buttons', 'bool'),
      c('daily_cap', 'int'),
      c('max_age_sec', 'int'),
      c('legacy_id', 'text'),
      c('created_at', 'timestamptz'),
      c('updated_at', 'timestamptz', true),
    ],
    naturalKeys: [],
  },
  automation_cooldowns: {
    name: 'automation_cooldowns',
    table: 'automation_cooldowns',
    source: 'cooldowns',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('automation_id', 'uuid'),
      c('status_id', 'uuid'),
      c('provider_status_id', 'text'),
      c('contact_key', 'text'),
      c('replied_at', 'timestamptz'),
    ],
    naturalKeys: [
      {
        name: 'account_status_contact',
        sql: keySql('account_id::text', 'provider_status_id', 'contact_key'),
        fromRow: (r) => key(r.account_id, r.provider_status_id, r.contact_key),
      },
    ],
  },
  contacts: {
    name: 'contacts',
    table: 'contacts',
    source: 'contact_aliases',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('pn_jid', 'text'),
      c('lid', 'text'),
      c('display_name', 'text'),
      c('created_at', 'timestamptz'),
      c('updated_at', 'timestamptz', true),
    ],
    naturalKeys: [
      {
        name: 'account_identity',
        sql: keySql('account_id::text', 'coalesce(lid, pn_jid)'),
        fromRow: (r) => key(r.account_id, r.lid ?? r.pn_jid),
      },
    ],
  },
  api_clients: {
    name: 'api_clients',
    table: 'api_clients',
    source: 'agent_tokens',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('name', 'text'),
      c('key_prefix', 'text'),
      c('key_hash', 'text'),
      c('scopes', 'text[]'),
      c('account_ids', 'uuid[]'),
      c('legacy', 'bool'),
      c('created_at', 'timestamptz'),
      c('revoked_at', 'timestamptz'),
      c('last_used_at', 'timestamptz', true),
    ],
    naturalKeys: [
      { name: 'key_prefix', sql: 'key_prefix', fromRow: (r) => key(r.key_prefix) },
      // Not a DB constraint, but two clients with one hash would make legacy lookup ambiguous.
      { name: 'key_hash', sql: 'key_hash', fromRow: (r) => key(r.key_hash) },
    ],
  },
  conversations: {
    name: 'conversations',
    table: 'conversations',
    source: 'chat_messages',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('chat_jid', 'text'),
      c('type', 'text'),
      c('last_inbound_at', 'timestamptz'),
      c('last_message_at', 'timestamptz'),
      c('created_at', 'timestamptz'),
    ],
    naturalKeys: [
      {
        name: 'account_chat',
        sql: keySql('account_id::text', 'chat_jid'),
        fromRow: (r) => key(r.account_id, r.chat_jid),
      },
    ],
  },
  messages: {
    name: 'messages',
    table: 'messages',
    source: 'chat_messages',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('conversation_id', 'uuid'),
      c('direction', 'text'),
      c('kind', 'text'),
      c('body', 'text'),
      c('media_path', 'text'),
      c('media_mime', 'text'),
      c('status', 'text'),
      c('provider_message_id', 'text'),
      c('sender_jid', 'text'),
      c('from_me', 'bool'),
      c('push_name', 'text'),
      c('error_code', 'text'),
      c('received_at', 'timestamptz'),
      c('sent_at', 'timestamptz'),
      c('created_at', 'timestamptz'),
    ],
    naturalKeys: [
      {
        name: 'account_provider_message',
        sql: keySql('account_id::text', 'provider_message_id'),
        fromRow: (r) => key(r.account_id, r.provider_message_id),
      },
    ],
  },
  reminders: {
    name: 'reminders',
    table: 'reminders',
    source: 'reminders',
    mode: 'upsert',
    columns: [
      c('id', 'uuid'),
      c('org_id', 'uuid'),
      c('account_id', 'uuid'),
      c('legacy_id', 'text'),
      c('to_e164', 'text'),
      c('body', 'text'),
      c('template_name', 'text'),
      c('template_language', 'text'),
      c('template_params', 'jsonb'),
      c('due_at', 'timestamptz'),
      c('state', 'text'),
      c('attempts', 'int'),
      c('error_code', 'text'),
      c('created_at', 'timestamptz'),
      c('cancelled_at', 'timestamptz'),
      c('updated_at', 'timestamptz', true),
    ],
    naturalKeys: [],
  },
};

export function verifiedColumns(spec: TableSpec): ColumnSpec[] {
  return spec.columns.filter((col) => !col.insertOnly);
}

export const PG_TYPE: Record<ColType, string> = {
  uuid: 'uuid',
  text: 'text',
  bool: 'boolean',
  int: 'integer',
  timestamptz: 'timestamptz',
  jsonb: 'jsonb',
  'text[]': 'text[]',
  'uuid[]': 'uuid[]',
};
