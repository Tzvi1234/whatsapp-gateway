/**
 * Pure transform: validated legacy rows -> target rows (ARCHITECTURE.md §9.3 step 3).
 *
 *  - ms epochs -> ISO-8601 UTC timestamptz strings;
 *  - slot `default` -> Baileys account id, `meta-default` -> Cloud account id (CLI args);
 *  - legacy agent tokens -> api_clients with all 7 legacy scopes, `legacy = true`;
 *  - phone numbers -> E.164 via @htz/core `toE164`, JIDs via `normalizeJid`;
 *  - chat_messages limited to the last N days; reminders to non-terminal + last N days;
 *  - deterministic target ids (UUID v5 over `org:table:legacyId`) so re-runs are idempotent (M1);
 *    reminders keep their legacy id when it is already a UUID, and keep their state (M4).
 *
 * No I/O, no clock: `now` is an input.
 */
import { createHash } from 'node:crypto';
import { LEGACY_SCOPES, normalizeJid, toE164 } from '@htz/core';
import type { RowIssue } from './extract';
import type { LegacyData, LegacyRow, LegacyTable } from './legacy-schema';
import { TABLE_SPECS, TARGETS, type TargetName } from './tables';

export type Row = Record<string, unknown> & { __rowid: number };

export interface TransformOptions {
  orgId: string;
  baileysAccountId: string;
  cloudAccountId: string;
  /** chat_messages / terminal reminders older than this many days are not migrated. */
  sinceDays: number;
  now: Date;
  /**
   * `null`: legacy keys get `key_prefix = null` (looked up by hash, packages/mcp/src/auth.ts).
   * `sentinel`: `legacy-<target id>` for schemas where key_prefix is still NOT NULL (globally
   * unique); it can never match a real `gw_<8 alnum>_` prefix because of the `-`.
   */
  legacyKeyPrefix: 'null' | 'sentinel';
}

export interface TransformResult {
  rows: Record<TargetName, Row[]>;
  /** Not loaded. */
  rejects: RowIssue[];
  /** Loaded, with a documented adjustment (e.g. dangling reference nulled). */
  warnings: RowIssue[];
  /** Rows intentionally left out by the time window, per legacy table. */
  excludedByWindow: Partial<Record<LegacyTable, number>>;
  cutoff: string;
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

/** Fixed namespace of this migration (never change it: ids of already-migrated rows depend on it). */
export const MIGRATION_NAMESPACE = '3c9a1f4e-8d2b-4c6a-9e7f-1b2d3c4e5f60';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** RFC 4122 / 9562 UUID version 5 (SHA-1, name-based), implemented with node:crypto. */
export function uuidV5(name: string, namespace: string): string {
  if (!isUuid(namespace)) throw new Error('namespace must be a UUID');
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic target id for a legacy row. */
export function targetId(orgId: string, kind: string, legacyId: string | number): string {
  return uuidV5(`${orgId.toLowerCase()}:${kind}:${String(legacyId)}`, MIGRATION_NAMESPACE);
}

// ---------------------------------------------------------------------------
// value helpers
// ---------------------------------------------------------------------------

export function msToIso(ms: number): string;
export function msToIso(ms: number | null): string | null;
export function msToIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export type Slot = 'default' | 'meta-default';

export function accountForSlot(
  slot: Slot | null,
  fallback: Slot,
  opts: Pick<TransformOptions, 'baileysAccountId' | 'cloudAccountId'>,
): string {
  return (slot ?? fallback) === 'default' ? opts.baileysAccountId : opts.cloudAccountId;
}

/** Legacy tokens get exactly the 7 legacy v1 scopes, whatever they stored. */
export function legacyTokenScopes(): string[] {
  return [...LEGACY_SCOPES];
}

export function phoneToE164(input: string | null): string | null {
  if (input === null) return null;
  const r = toE164(input);
  return r.ok ? r.value : null;
}

export const REMINDER_TERMINAL_STATES = new Set([
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
]);

export function mapReminderState(s: string): string {
  return s === 'pending' ? 'scheduled' : s;
}

const INBOUND_KINDS = new Set([
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'view_once',
  'reaction',
  'interactive_reply',
]);
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker']);
const TEXT_ALIASES = new Set(['chat', 'conversation', 'extendedText', 'extended_text']);

export function mapMessageKind(type: string, fromMe: boolean): string {
  let t = type === 'ptt' ? 'voice' : TEXT_ALIASES.has(type) ? 'text' : type;
  if (!INBOUND_KINDS.has(t)) t = 'unknown';
  if (!fromMe) return t;
  if (MEDIA_TYPES.has(t)) return 'media';
  return t === 'text' || t === 'reaction' ? t : 'unknown';
}

/** Returns target status + error code. Unsent legacy outbound messages become failed. */
export function mapMessageStatus(
  status: string | null,
  fromMe: boolean,
  hasProviderId: boolean,
): { status: string; errorCode: string | null } {
  const s = status?.toLowerCase() ?? null;
  if (!fromMe) return { status: s === 'read' ? 'read' : 'delivered', errorCode: null };
  if (s === 'sent' || s === 'delivered' || s === 'read' || s === 'failed' || s === 'cancelled') {
    return { status: s, errorCode: null };
  }
  if (s === 'pending' || s === 'queued' || s === 'sending' || !hasProviderId) {
    return { status: 'failed', errorCode: 'legacy_unsent' };
  }
  return { status: 'sent', errorCode: null };
}

function normalizedJidOrNull(raw: string): { jid: string; kind: string } | null {
  const r = normalizeJid(raw);
  return r.ok ? { jid: r.value.jid, kind: r.value.kind } : null;
}

const SETTINGS_INT_KEYS: Record<string, string> = {
  daily_cap: 'dailyCap',
  min_delay_ms: 'minDelayMs',
  max_delay_ms: 'maxDelayMs',
};
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,48}$/;

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

export function transform(data: LegacyData, opts: TransformOptions): TransformResult {
  const { orgId } = opts;
  const rejects: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const excludedByWindow: Partial<Record<LegacyTable, number>> = {};
  const cutoffMs = opts.now.getTime() - opts.sinceDays * 86_400_000;
  const rows = Object.fromEntries(TARGETS.map((t) => [t, [] as Row[]])) as Record<
    TargetName,
    Row[]
  >;
  const reject = (table: LegacyTable, row: { __rowid: number }, reason: string) =>
    rejects.push({ table, rowid: row.__rowid, reason });
  const warn = (table: LegacyTable, row: { __rowid: number }, reason: string) =>
    warnings.push({ table, rowid: row.__rowid, reason });
  const account = (slot: Slot | null, fallback: Slot) => accountForSlot(slot, fallback, opts);

  // accounts: the two mapped accounts always exist; linked_accounts supplies label/phone.
  const linked = new Map<string, LegacyRow<'linked_accounts'>>();
  for (const r of data.linked_accounts) {
    const expected = r.id === 'default' ? 'baileys' : 'meta';
    if (r.kind !== expected) {
      reject('linked_accounts', r, 'invalid:kind:slot_kind_mismatch');
      continue;
    }
    linked.set(r.id, r);
  }
  for (const [alias, id, provider, fallbackLabel] of [
    ['default', opts.baileysAccountId, 'baileys', 'Legacy default (Baileys)'],
    ['meta-default', opts.cloudAccountId, 'meta_cloud', 'Legacy meta-default (Cloud API)'],
  ] as const) {
    const l = linked.get(alias);
    let phone: string | null = null;
    if (l?.phone) {
      phone = phoneToE164(l.phone);
      if (!phone) warn('linked_accounts', l, 'phone_not_e164_dropped');
    }
    rows.accounts.push({
      __rowid: l?.__rowid ?? -1,
      id,
      org_id: orgId,
      provider,
      alias,
      label: l?.label?.trim() || fallbackLabel,
      phone_e164: phone,
    });
  }

  // settings -> accounts.pacing (Baileys account)
  const pacing: Record<string, unknown> = {};
  for (const r of data.settings) {
    const intKey = SETTINGS_INT_KEYS[r.key];
    if (intKey) {
      const n = r.value === null ? NaN : Number(r.value.trim());
      if (!Number.isInteger(n) || n < 0) {
        reject('settings', r, `invalid:${r.key}:not_non_negative_int`);
        continue;
      }
      pacing[intKey] = n;
    } else if (r.key === 'timezone') {
      if (!r.value?.trim()) {
        reject('settings', r, 'invalid:timezone:empty');
        continue;
      }
      pacing.timezone = r.value.trim();
    } else {
      warn('settings', r, `unmapped_setting:${SAFE_KEY.test(r.key) ? r.key : '(unsafe key)'}`);
    }
  }
  if (Object.keys(pacing).length > 0) {
    rows.account_settings.push({ __rowid: -1, id: opts.baileysAccountId, pacing });
  }

  // statuses
  const statusIds = new Map<number, { id: string; providerStatusId: string }>();
  for (const r of data.statuses) {
    const id = targetId(orgId, 'statuses', r.id);
    statusIds.set(r.id, { id, providerStatusId: r.wa_status_id });
    rows.statuses.push({
      __rowid: r.__rowid,
      id,
      org_id: orgId,
      account_id: account(r.slot, 'default'),
      provider_status_id: r.wa_status_id,
      kind: r.kind,
      caption: r.caption,
      media_path: r.media_path,
      posted_at: msToIso(r.posted_at),
      expires_at: msToIso(r.expires_at),
      legacy_id: String(r.id),
      created_at: msToIso(r.posted_at),
    });
  }

  // automations
  const automationIds = new Map<number, string>();
  for (const r of data.automations) {
    const id = targetId(orgId, 'automations', r.id);
    automationIds.set(r.id, id);
    let statusId: string | null = null;
    if (r.status_id !== null) {
      statusId = statusIds.get(r.status_id)?.id ?? null;
      if (!statusId) warn('automations', r, 'status_ref_missing_nulled');
    }
    rows.automations.push({
      __rowid: r.__rowid,
      id,
      org_id: orgId,
      account_id: account(r.slot, 'default'),
      name: r.name,
      enabled: r.enabled,
      bind_mode: r.bind_mode,
      status_id: statusId,
      keywords: r.keywords,
      match_mode: r.match_mode,
      case_sensitive: r.case_sensitive,
      ignore_emoji: r.ignore_emoji,
      reply_text: r.reply_text,
      reply_media_path: r.reply_media_path,
      options: r.options ?? [],
      try_native_buttons: r.try_native_buttons,
      daily_cap: r.daily_cap,
      max_age_sec: r.max_age_sec ?? 300,
      legacy_id: String(r.id),
      created_at: msToIso(r.created_at),
      updated_at: msToIso(r.updated_at),
    });
  }

  // cooldowns
  for (const r of data.cooldowns) {
    const contact = normalizedJidOrNull(r.contact_jid);
    if (!contact) {
      reject('cooldowns', r, 'invalid:contact_jid:invalid_jid');
      continue;
    }
    let automationId: string | null = null;
    if (r.automation_id !== null) {
      automationId = automationIds.get(r.automation_id) ?? null;
      if (!automationId) warn('cooldowns', r, 'automation_ref_missing_nulled');
    }
    let statusId: string | null = null;
    if (r.status_id !== null) {
      statusId = statusIds.get(r.status_id)?.id ?? null;
      if (!statusId) warn('cooldowns', r, 'status_ref_missing_nulled');
    }
    rows.automation_cooldowns.push({
      __rowid: r.__rowid,
      id: targetId(orgId, 'cooldowns', r.id),
      org_id: orgId,
      account_id: account(r.slot, 'default'),
      automation_id: automationId,
      status_id: statusId,
      provider_status_id: r.wa_status_id,
      contact_key: contact.jid,
      replied_at: msToIso(r.replied_at),
    });
  }

  // contact aliases -> contacts
  for (const r of data.contact_aliases) {
    const j = normalizedJidOrNull(r.jid);
    if (!j || (j.kind !== 'pn' && j.kind !== 'lid')) {
      reject('contact_aliases', r, 'invalid:jid:not_a_pn_or_lid');
      continue;
    }
    rows.contacts.push({
      __rowid: r.__rowid,
      id: targetId(orgId, 'contact_aliases', r.id),
      org_id: orgId,
      account_id: account(r.slot, 'default'),
      pn_jid: j.kind === 'pn' ? j.jid : null,
      lid: j.kind === 'lid' ? j.jid : null,
      display_name: r.alias,
      created_at: msToIso(r.created_at),
      updated_at: msToIso(r.updated_at),
    });
  }

  // agent tokens -> api_clients (hash only)
  for (const r of data.agent_tokens) {
    const id = targetId(orgId, 'agent_tokens', r.id);
    rows.api_clients.push({
      __rowid: r.__rowid,
      id,
      org_id: orgId,
      name: r.name?.trim() || `legacy token ${r.id}`,
      key_prefix: opts.legacyKeyPrefix === 'sentinel' ? `legacy-${id}` : null,
      key_hash: r.token_hash,
      scopes: legacyTokenScopes(),
      account_ids: [opts.baileysAccountId, opts.cloudAccountId],
      legacy: true,
      created_at: msToIso(r.created_at),
      revoked_at: msToIso(r.revoked_at),
      last_used_at: msToIso(r.last_used_at),
    });
  }

  // chat messages (last N days) -> messages + conversations
  const convs = new Map<string, Row & { __first: number; __last: number; __lastIn: number }>();
  const msgRows: Row[] = [];
  let excludedMsgs = 0;
  for (const r of data.chat_messages) {
    if (r.timestamp < cutoffMs) {
      excludedMsgs++;
      continue;
    }
    const chat = normalizedJidOrNull(r.chat_jid);
    if (!chat) {
      reject('chat_messages', r, 'invalid:chat_jid:invalid_jid');
      continue;
    }
    const accountId = account(r.slot, 'default');
    const convId = targetId(orgId, 'conversations', `${accountId}:${chat.jid}`);
    const { status, errorCode } = mapMessageStatus(r.status, r.from_me, true);
    msgRows.push({
      __rowid: r.__rowid,
      id: targetId(orgId, 'chat_messages', r.id),
      org_id: orgId,
      account_id: accountId,
      conversation_id: convId,
      direction: r.from_me ? 'out' : 'in',
      kind: mapMessageKind(r.type, r.from_me),
      body: r.body,
      media_path: r.media_path,
      media_mime: r.media_mime,
      status,
      provider_message_id: r.wa_message_id,
      sender_jid: r.sender_jid,
      from_me: r.from_me,
      push_name: r.push_name,
      error_code: errorCode,
      received_at: r.from_me ? null : msToIso(r.timestamp),
      sent_at: r.from_me && status !== 'failed' ? msToIso(r.timestamp) : null,
      created_at: msToIso(r.timestamp),
      __chat: chat.jid,
      __chatKind: chat.kind,
      __ts: r.timestamp,
    });
  }
  if (excludedMsgs) excludedByWindow.chat_messages = excludedMsgs;
  rows.messages = dedupe('chat_messages', 'messages', msgRows, rejects);
  for (const m of rows.messages) {
    const ts = m.__ts as number;
    const fromMe = m.from_me as boolean;
    let c = convs.get(m.conversation_id as string);
    if (!c) {
      const kind = m.__chatKind as string;
      c = {
        __rowid: -1,
        __first: ts,
        __last: ts,
        __lastIn: -1,
        id: m.conversation_id,
        org_id: orgId,
        account_id: m.account_id,
        chat_jid: m.__chat,
        type: kind === 'group' ? 'group' : kind === 'status' ? 'status' : 'direct',
      };
      convs.set(c.id as string, c);
    }
    c.__first = Math.min(c.__first, ts);
    c.__last = Math.max(c.__last, ts);
    if (!fromMe) c.__lastIn = Math.max(c.__lastIn, ts);
  }
  rows.conversations = [...convs.values()].map(({ __first, __last, __lastIn, ...c }) => ({
    ...c,
    created_at: msToIso(__first),
    last_message_at: msToIso(__last),
    last_inbound_at: __lastIn >= 0 ? msToIso(__lastIn) : null,
  }));

  // reminders: non-terminal always, terminal only within the window; ids + state kept (M4)
  let excludedRem = 0;
  for (const r of data.reminders) {
    const state = mapReminderState(r.state);
    if (REMINDER_TERMINAL_STATES.has(state) && Math.max(r.updated_at, r.due_at) < cutoffMs) {
      excludedRem++;
      continue;
    }
    const to = phoneToE164(r.to_phone);
    if (!to) {
      reject('reminders', r, 'invalid:to_phone:not_e164');
      continue;
    }
    rows.reminders.push({
      __rowid: r.__rowid,
      id: isUuid(r.id) ? r.id.toLowerCase() : targetId(orgId, 'reminders', r.id),
      org_id: orgId,
      account_id: account(r.slot, 'meta-default'),
      legacy_id: r.id,
      to_e164: to,
      body: r.body,
      template_name: r.template_name,
      template_language: r.template_language,
      template_params: r.template_params ?? [],
      due_at: msToIso(r.due_at),
      state,
      attempts: r.attempts,
      error_code: r.error_code,
      created_at: msToIso(r.created_at),
      cancelled_at: msToIso(r.cancelled_at),
      updated_at: msToIso(r.updated_at),
    });
  }
  if (excludedRem) excludedByWindow.reminders = excludedRem;

  // natural-key duplicates inside the source are rejected (first row wins)
  rows.statuses = dedupe('statuses', 'statuses', rows.statuses, rejects);
  rows.automation_cooldowns = dedupe(
    'cooldowns',
    'automation_cooldowns',
    rows.automation_cooldowns,
    rejects,
  );
  rows.contacts = dedupe('contact_aliases', 'contacts', rows.contacts, rejects);
  rows.api_clients = dedupe('agent_tokens', 'api_clients', rows.api_clients, rejects);
  rows.reminders = dedupe('reminders', 'reminders', rows.reminders, rejects, true);

  return { rows, rejects, warnings, excludedByWindow, cutoff: new Date(cutoffMs).toISOString() };
}

/** Drops rows whose id or natural key repeats an earlier row, reporting each one. */
function dedupe(
  source: LegacyTable,
  target: TargetName,
  input: Row[],
  rejects: RowIssue[],
  byIdOnly = false,
): Row[] {
  const spec = TABLE_SPECS[target];
  const seen = new Map<string, Set<string>>();
  const out: Row[] = [];
  for (const row of input) {
    const keys: [string, string | null][] = [['id', String(row.id)]];
    if (!byIdOnly) for (const k of spec.naturalKeys) keys.push([k.name, k.fromRow(row)]);
    const dup = keys.find(([name, v]) => v !== null && seen.get(name)?.has(v));
    if (dup) {
      rejects.push({ table: source, rowid: row.__rowid, reason: `duplicate_key:${dup[0]}` });
      continue;
    }
    for (const [name, v] of keys) {
      if (v === null) continue;
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name)!.add(v);
    }
    out.push(row);
  }
  return out;
}
