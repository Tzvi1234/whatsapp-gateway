import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_SCOPES } from '@htz/core';
import { extract, openLegacyDb, type Extracted } from './extract';
import {
  isUuid,
  mapMessageKind,
  mapMessageStatus,
  msToIso,
  targetId,
  transform,
  uuidV5,
  type TransformOptions,
} from './transform';
import {
  BAILEYS,
  buildFixture,
  CLOUD,
  FIXTURE_NOW,
  ORG,
  REMINDER_UUID,
  SENSITIVE,
} from './test-fixture';

const opts: TransformOptions = {
  orgId: ORG,
  baileysAccountId: BAILEYS,
  cloudAccountId: CLOUD,
  sinceDays: 30,
  now: FIXTURE_NOW,
  legacyKeyPrefix: 'null',
};

let fx: { dir: string; path: string };
let ex: Extracted;

beforeAll(() => {
  fx = buildFixture();
  const db = openLegacyDb(fx.path);
  ex = extract(db, fx.path);
  db.close();
});
afterAll(() => rmSync(fx.dir, { recursive: true, force: true }));

describe('ids', () => {
  it('M1: uuidV5 matches the RFC 4122 test vector', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('M1: target ids are deterministic, valid v5 UUIDs, and scoped by org/table/id', () => {
    const a = targetId(ORG, 'automations', 1);
    expect(a).toBe(targetId(ORG, 'automations', 1));
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('5');
    expect(a).not.toBe(targetId(ORG, 'statuses', 1));
    expect(a).not.toBe(targetId(BAILEYS, 'automations', 1));
  });
});

describe('transform', () => {
  it('M1: two transforms of the same snapshot are identical (idempotent input to load)', () => {
    const a = transform(ex.data, opts);
    const b = transform(ex.data, opts);
    expect(b).toEqual(a);
    // and re-extracting gives the same result too
    const db = openLegacyDb(fx.path);
    const ex2 = extract(db, fx.path);
    db.close();
    expect(transform(ex2.data, opts)).toEqual(a);
  });

  it('M1: ms epochs become ISO timestamptz strings', () => {
    expect(msToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    const t = transform(ex.data, opts);
    const a1 = t.rows.automations.find((r) => r.legacy_id === '1')!;
    expect(a1.created_at).toBe(new Date(FIXTURE_NOW.getTime() - 50 * 86_400_000).toISOString());
  });

  it('M1: slots map to the Baileys / Cloud accounts; linked_accounts phones to E.164', () => {
    const t = transform(ex.data, opts);
    expect(t.rows.accounts).toEqual([
      expect.objectContaining({
        id: BAILEYS,
        provider: 'baileys',
        alias: 'default',
        label: 'Test Baileys',
        phone_e164: '+972559014410',
      }),
      expect.objectContaining({
        id: CLOUD,
        provider: 'meta_cloud',
        alias: 'meta-default',
        phone_e164: '+972559014410',
      }),
    ]);
    expect(new Set(t.rows.automations.map((r) => r.account_id))).toEqual(new Set([BAILEYS]));
    expect(new Set(t.rows.statuses.map((r) => r.account_id))).toEqual(new Set([BAILEYS]));
    expect(new Set(t.rows.reminders.map((r) => r.account_id))).toEqual(new Set([CLOUD]));
  });

  it('M1: settings map to the Baileys account pacing; unknown keys are warned', () => {
    const t = transform(ex.data, opts);
    expect(t.rows.account_settings).toEqual([
      expect.objectContaining({
        id: BAILEYS,
        pacing: { dailyCap: 50, minDelayMs: 1000, maxDelayMs: 10000, timezone: 'Asia/Jerusalem' },
      }),
    ]);
    expect(t.warnings).toContainEqual(
      expect.objectContaining({ table: 'settings', reason: 'unmapped_setting:theme' }),
    );
  });

  it('M1: legacy tokens get all 7 legacy scopes, legacy=true, null key_prefix, lowercase hash', () => {
    const t = transform(ex.data, opts);
    expect(t.rows.api_clients).toHaveLength(2);
    for (const c of t.rows.api_clients) {
      expect(c.scopes).toEqual([...LEGACY_SCOPES]);
      expect(c.legacy).toBe(true);
      expect(c.key_prefix).toBeNull();
      expect(c.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.account_ids).toEqual([BAILEYS, CLOUD]);
    }
    expect(t.rows.api_clients[1]!.revoked_at).not.toBeNull();
    const s = transform(ex.data, { ...opts, legacyKeyPrefix: 'sentinel' });
    expect(s.rows.api_clients.map((c) => c.key_prefix)).toEqual([
      `legacy-${targetId(ORG, 'agent_tokens', 1)}`,
      `legacy-${targetId(ORG, 'agent_tokens', 2)}`,
    ]);
  });

  it('M1: automations keep matching config; dangling status reference is nulled with a warning', () => {
    const t = transform(ex.data, opts);
    const a1 = t.rows.automations.find((r) => r.legacy_id === '1')!;
    expect(a1.status_id).toBe(targetId(ORG, 'statuses', 1));
    expect(a1.keywords).toEqual(['שָׁלוֹם', 'price']);
    expect(a1.max_age_sec).toBe(300);
    const a2 = t.rows.automations.find((r) => r.legacy_id === '2')!;
    expect(a2).toMatchObject({ bind_mode: 'next_status', enabled: false, options: [] });
    const a3 = t.rows.automations.find((r) => r.legacy_id === '3')!;
    expect(a3.status_id).toBeNull();
    expect(t.warnings).toContainEqual(
      expect.objectContaining({ table: 'automations', reason: 'status_ref_missing_nulled' }),
    );
  });

  it('M1: contacts and cooldown keys are normalised JIDs; duplicates rejected by identity', () => {
    const t = transform(ex.data, opts);
    expect(t.rows.contacts.map((c) => [c.pn_jid, c.lid])).toEqual([
      ['972559014410@s.whatsapp.net', null],
      [null, '111222333@lid'],
    ]);
    expect(t.rows.automation_cooldowns.map((c) => c.contact_key)).toEqual([
      '972559014410@s.whatsapp.net',
      '123456789@lid',
    ]);
    expect(t.rejects).toContainEqual({
      table: 'contact_aliases',
      rowid: 2,
      reason: 'duplicate_key:account_identity',
    });
    expect(t.rejects).toContainEqual({
      table: 'cooldowns',
      rowid: 3,
      reason: 'invalid:contact_jid:invalid_jid',
    });
  });

  it('M1: chat_messages limited to the window; conversations derived; unsent outbound -> failed', () => {
    const t = transform(ex.data, opts);
    expect(t.excludedByWindow.chat_messages).toBe(1);
    expect(t.rows.messages.map((m) => m.provider_message_id)).toEqual([
      'WAMSG-1',
      'WAMSG-2',
      'WAMSG-4',
      'WAMSG-5',
    ]);
    expect(t.rejects).toContainEqual({
      table: 'chat_messages',
      rowid: 7,
      reason: 'duplicate_key:account_provider_message',
    });
    const m4 = t.rows.messages.find((m) => m.provider_message_id === 'WAMSG-4')!;
    expect(m4).toMatchObject({ kind: 'voice', direction: 'in', status: 'delivered' });
    const m5 = t.rows.messages.find((m) => m.provider_message_id === 'WAMSG-5')!;
    expect(m5).toMatchObject({ status: 'failed', error_code: 'legacy_unsent', sent_at: null });
    expect(t.rows.conversations).toHaveLength(2);
    const direct = t.rows.conversations.find((c) => c.type === 'direct')!;
    expect(direct.chat_jid).toBe('972559014410@s.whatsapp.net');
    expect(direct.last_message_at).toBe(m5.created_at);
    expect(t.rows.conversations.find((c) => c.type === 'group')).toBeTruthy();
  });

  it('M4: reminders keep ids and state; unconfigured stays unconfigured; old terminal excluded', () => {
    const t = transform(ex.data, opts);
    const byLegacy = new Map(t.rows.reminders.map((r) => [r.legacy_id, r]));
    const u = byLegacy.get(REMINDER_UUID.toUpperCase())!;
    expect(u.id).toBe(REMINDER_UUID);
    expect(u).toMatchObject({
      state: 'unconfigured',
      attempts: 3,
      to_e164: '+972559014410',
      template_params: ['x', 2],
    });
    expect(byLegacy.get('r-legacy-2')!.state).toBe('scheduled');
    expect(byLegacy.get('r-legacy-2')!.id).toBe(targetId(ORG, 'reminders', 'r-legacy-2'));
    expect(byLegacy.get('r4')!.state).toBe('failed');
    expect(byLegacy.get('r6')!.state).toBe('cancelled');
    expect(byLegacy.has('r3')).toBe(false);
    expect(t.excludedByWindow.reminders).toBe(1);
    expect(t.rejects).toContainEqual({
      table: 'reminders',
      rowid: 5,
      reason: 'invalid:to_phone:not_e164',
    });
  });

  it('M2: rejects identify table + rowid + reason only, never values', () => {
    const t = transform(ex.data, opts);
    const all = [...ex.rejects, ...t.rejects];
    expect(all).toContainEqual({
      table: 'automations',
      rowid: 4,
      reason: 'invalid:keywords:invalid_json_string_array',
    });
    expect(all).toContainEqual({
      table: 'chat_messages',
      rowid: 6,
      reason: 'invalid:timestamp:not_ms_epoch',
    });
    expect(all).toContainEqual({
      table: 'agent_tokens',
      rowid: 3,
      reason: 'invalid:token_hash:not_sha256_hex',
    });
    const text = JSON.stringify(all);
    for (const s of SENSITIVE) expect(text).not.toContain(s);
  });
});

describe('mappers', () => {
  it('M1: message kinds and statuses', () => {
    expect(mapMessageKind('ptt', false)).toBe('voice');
    expect(mapMessageKind('image', true)).toBe('media');
    expect(mapMessageKind('weird', false)).toBe('unknown');
    expect(mapMessageKind('conversation', true)).toBe('text');
    expect(mapMessageStatus(null, false, true)).toEqual({ status: 'delivered', errorCode: null });
    expect(mapMessageStatus('read', true, true)).toEqual({ status: 'read', errorCode: null });
    expect(mapMessageStatus(null, true, true)).toEqual({ status: 'sent', errorCode: null });
    expect(mapMessageStatus('queued', true, true).status).toBe('failed');
  });
});
