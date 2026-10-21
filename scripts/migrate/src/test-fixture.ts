/**
 * Test-only: builds a legacy SQLite file with the ASSUMED schema and fictitious data.
 * The only phone number is the project's fictitious test number +972559014410.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { assumedDdl } from './legacy-schema';

export const FIXTURE_NOW = new Date('2026-10-21T12:00:00.000Z');
export const ORG = '00000000-0000-4000-8000-000000000001';
export const BAILEYS = '11111111-1111-4111-8111-111111111111';
export const CLOUD = '22222222-2222-4222-8222-222222222222';
export const REMINDER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const TOKEN_ONE = 'legacy-token-one-0123456789abcdef';
/** Strings that must never appear in any output (bodies, phones, tokens, hashes). */
export const SENSITIVE = [
  '972559014410',
  '0559014410',
  '901-4410',
  'secret body',
  'reply body',
  'Test User',
  'hello group',
  TOKEN_ONE,
  createHash('sha256').update(TOKEN_ONE).digest('hex'),
  '202 555',
  'caption one',
];

const DAY = 86_400_000;
const at = (daysAgo: number) => FIXTURE_NOW.getTime() - daysAgo * DAY;

export interface FixtureOptions {
  /** Leave these tables out (to test missing-table reporting). */
  omit?: string[];
  /** Id of the UUID-keyed reminder (default REMINDER_UUID). */
  reminderUuid?: string;
}

export function buildFixture(opts: FixtureOptions = {}): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'htz-migrate-'));
  const path = join(dir, 'whatsapp-automation.sqlite');
  const db = new Database(path);
  const ddl = assumedDdl()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !(opts.omit ?? []).some((t) => s.startsWith(`CREATE TABLE ${t} `)));
  for (const s of ddl) db.exec(`${s};`);
  const has = (t: string) => !(opts.omit ?? []).includes(t);
  const ins = (table: string, row: Record<string, unknown>) => {
    if (!has(table)) return;
    const cols = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    ).run(row);
  };

  ins('linked_accounts', {
    id: 'default',
    kind: 'baileys',
    label: 'Test Baileys',
    phone: '0559014410',
    created_at: at(100),
  });
  ins('linked_accounts', {
    id: 'meta-default',
    kind: 'meta',
    label: null,
    phone: '+972 55-901-4410',
    created_at: at(100),
  });

  for (const [key, value] of [
    ['daily_cap', '50'],
    ['min_delay_ms', '1000'],
    ['max_delay_ms', '10000'],
    ['timezone', 'Asia/Jerusalem'],
    ['theme', 'dark'],
  ]) {
    ins('settings', { key, value });
  }

  ins('statuses', {
    id: 1,
    slot: 'default',
    wa_status_id: 'STATUS-1',
    kind: 'image',
    caption: 'caption one',
    media_path: 'media/s1.jpg',
    posted_at: at(1),
    expires_at: at(0),
  });
  ins('statuses', {
    id: 2,
    slot: null,
    wa_status_id: 'STATUS-2',
    kind: 'text',
    caption: null,
    media_path: null,
    posted_at: at(3),
    expires_at: null,
  });

  const automation = (id: number, extra: Record<string, unknown>) => ({
    id,
    slot: 'default',
    name: `automation ${id}`,
    enabled: 1,
    bind_mode: 'status',
    status_id: null,
    keywords: JSON.stringify(['שָׁלוֹם', 'price']),
    match_mode: 'contains',
    case_sensitive: 0,
    ignore_emoji: 1,
    reply_text: 'reply body {name}',
    reply_media_path: null,
    options: JSON.stringify(['one', 'two']),
    try_native_buttons: 0,
    daily_cap: 20,
    max_age_sec: null,
    created_at: at(50),
    updated_at: at(10),
    ...extra,
  });
  ins('automations', automation(1, { status_id: 1 }));
  ins('automations', automation(2, { bind_mode: 'next_status', options: null, enabled: 0 }));
  ins('automations', automation(3, { status_id: 99 })); // dangling -> warning, nulled
  ins('automations', automation(4, { keywords: 'not json' })); // reject

  ins('cooldowns', {
    id: 1,
    slot: 'default',
    automation_id: 1,
    status_id: 1,
    wa_status_id: 'STATUS-1',
    contact_jid: '972559014410:3@s.whatsapp.net',
    replied_at: at(1),
  });
  ins('cooldowns', {
    id: 2,
    slot: 'default',
    automation_id: 1,
    status_id: 1,
    wa_status_id: 'STATUS-1',
    contact_jid: '123456789@lid',
    replied_at: at(1),
  });
  ins('cooldowns', {
    id: 3,
    slot: 'default',
    automation_id: null,
    status_id: null,
    wa_status_id: 'STATUS-1',
    contact_jid: 'garbage',
    replied_at: at(1),
  });

  ins('contact_aliases', {
    id: 1,
    slot: 'default',
    jid: '972559014410@s.whatsapp.net',
    alias: 'Test User',
    created_at: at(20),
    updated_at: at(5),
  });
  ins('contact_aliases', {
    id: 2,
    slot: 'default',
    jid: '0559014410', // same identity as id 1 -> duplicate_key reject
    alias: 'Test User again',
    created_at: at(20),
    updated_at: at(5),
  });
  ins('contact_aliases', {
    id: 3,
    slot: 'default',
    jid: '111222333@lid',
    alias: 'Lid Contact',
    created_at: at(20),
    updated_at: at(5),
  });

  const reminder = (id: string, extra: Record<string, unknown>) => ({
    id,
    slot: null,
    to_phone: '0559014410',
    body: 'secret body',
    template_name: null,
    template_language: null,
    template_params: null,
    due_at: at(-1),
    state: 'scheduled',
    attempts: 0,
    error_code: null,
    created_at: at(2),
    updated_at: at(2),
    cancelled_at: null,
    ...extra,
  });
  ins(
    'reminders',
    reminder((opts.reminderUuid ?? REMINDER_UUID).toUpperCase(), {
      state: 'unconfigured',
      template_name: 'reminder_v1',
      template_language: 'he',
      template_params: JSON.stringify(['x', 2]),
      attempts: 3,
      error_code: 'unconfigured',
    }),
  );
  ins('reminders', reminder('r-legacy-2', { state: 'pending' }));
  ins('reminders', reminder('r3', { state: 'sent', due_at: at(61), updated_at: at(60) })); // excluded
  ins('reminders', reminder('r4', { state: 'failed', due_at: at(3), updated_at: at(2) }));
  ins('reminders', reminder('r5', { to_phone: '+1 202 555 0100' })); // reject: not IL
  ins('reminders', reminder('r6', { state: 'cancelled', cancelled_at: at(1), updated_at: at(1) }));

  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  ins('agent_tokens', {
    id: 1,
    name: 'Grok Bot',
    token_hash: hash(TOKEN_ONE),
    scopes: 'messages:send',
    created_at: at(200),
    last_used_at: at(1),
    revoked_at: null,
  });
  ins('agent_tokens', {
    id: 2,
    name: null,
    token_hash: hash('another-legacy-token-value').toUpperCase(),
    scopes: null,
    created_at: at(200),
    last_used_at: null,
    revoked_at: at(30),
  });
  ins('agent_tokens', {
    id: 3,
    name: 'bcrypt one',
    token_hash: '$2b$10$abcdefghijklmnopqrstuv',
    scopes: null,
    created_at: at(200),
    last_used_at: null,
    revoked_at: null,
  });

  const msg = (id: number, extra: Record<string, unknown>) => ({
    id,
    slot: 'default',
    chat_jid: '972559014410@s.whatsapp.net',
    wa_message_id: `WAMSG-${id}`,
    from_me: 0,
    sender_jid: '972559014410@s.whatsapp.net',
    push_name: 'Test User',
    type: 'text',
    body: 'secret body',
    media_path: null,
    media_mime: null,
    status: null,
    timestamp: at(2),
    ...extra,
  });
  ins('chat_messages', msg(1, {}));
  ins(
    'chat_messages',
    msg(2, {
      from_me: 1,
      sender_jid: null,
      push_name: null,
      body: 'reply body',
      status: 'sent',
      timestamp: at(2) + 5000,
    }),
  );
  ins('chat_messages', msg(3, { timestamp: at(40) })); // excluded by window
  ins(
    'chat_messages',
    msg(4, {
      chat_jid: '120363000000000000@g.us',
      type: 'ptt',
      body: 'hello group',
      media_path: 'm/4.ogg',
      media_mime: 'audio/ogg',
    }),
  );
  ins(
    'chat_messages',
    msg(5, { from_me: 1, status: 'pending', body: 'reply body', timestamp: at(1) }),
  );
  ins('chat_messages', msg(6, { timestamp: Math.floor(at(1) / 1000) })); // seconds -> reject
  ins('chat_messages', msg(7, { wa_message_id: 'WAMSG-1', timestamp: at(1) })); // duplicate id

  db.close();
  return { dir, path };
}
