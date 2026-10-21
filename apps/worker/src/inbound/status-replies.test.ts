import { describe, expect, it } from 'vitest';
import type { AutomationRow } from '../db/types';
import { createOutbox } from '../queue/outbox';
import { STATUS_REPLY_KEY_PREFIX } from '../queue/processor';
import { buildAccountContext } from '../session/accounts';
import {
  ACC,
  FakeDb,
  FakeSession,
  TZVI_LID,
  TZVI_PN,
  inboundEvent,
  relayAccount,
  silentLogger,
} from '../test/fakes';
import { StatusReplies, toAutomation } from './status-replies';

function automation(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 'auto-1',
    account_id: ACC,
    name: 'promo',
    enabled: true,
    bind_mode: 'status',
    status_id: 'st-uuid',
    keywords: ['מחיר'],
    match_mode: 'contains',
    case_sensitive: false,
    ignore_emoji: true,
    reply_text: 'היי {name}',
    reply_media_path: null,
    options: [],
    try_native_buttons: false,
    daily_cap: null,
    max_age_sec: 300,
    created_at: new Date().toISOString(),
    provider_status_id: 'STATUS-1',
    ...over,
  };
}

function setup() {
  const db = new FakeDb();
  db.automations = [automation()];
  const session = new FakeSession(ACC);
  session.state = 'open';
  session.lidMap.set(TZVI_LID, TZVI_PN);
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sr = new StatusReplies({
    db,
    outbox: createOutbox({ db, wake: () => undefined, log: silentLogger() }),
    session: () => session,
    log: silentLogger(),
    rng: () => 0.5,
    timers: { setTimeout: (fn, ms) => timers.push({ fn, ms }) },
  });
  const ctx = buildAccountContext(
    relayAccount({ use_case_policy: { allowed_use_cases: ['status_automation'] } }),
    [],
    [],
  );
  const runTimers = async () => {
    for (const t of timers.splice(0)) t.fn();
    await sr.drain();
  };
  return { db, session, sr, ctx, runTimers, timers };
}

describe('status-reply automations', () => {
  it('R1.1/R2.5 matching reply: mark read now, typing, then enqueue through the queue (gate)', async () => {
    const t = setup();
    await t.sr.handle(
      t.ctx,
      inboundEvent({ text: 'מה המחיר?', statusReplyToId: 'STATUS-1', pushName: 'דני' }),
      'in-1',
    );
    expect(t.session.callsOf('markRead')).toHaveLength(1);
    expect(t.db.enqueued).toHaveLength(0); // waits for the pacing plan
    const send = t.timers.find((x) => x.ms > 0 && x.ms === Math.max(...t.timers.map((y) => y.ms)));
    expect(send!.ms).toBeGreaterThanOrEqual(1_000);
    expect(send!.ms).toBeLessThanOrEqual(10_000);
    await t.runTimers();
    expect(t.session.callsOf('presence')[0]?.[1]).toBe('composing');
    expect(t.db.enqueued[0]).toMatchObject({
      p_body: 'היי דני',
      p_use_case: 'status_automation',
      p_chat_jid: TZVI_PN,
    });
    expect(t.db.enqueued[0]?.p_idempotency_key?.startsWith(STATUS_REPLY_KEY_PREFIX)).toBe(true);
    expect(t.db.callsOf('recordReplyJob').at(-1)?.[1]).toBe('queued');
  });

  it('R2.2 the same person as PN and then as LID gets only one reply per status', async () => {
    const t = setup();
    await t.sr.handle(t.ctx, inboundEvent({ text: 'מחיר', statusReplyToId: 'STATUS-1' }), 'in-1');
    await t.runTimers();
    await t.sr.handle(
      t.ctx,
      inboundEvent({
        chat: TZVI_LID,
        senderPn: null,
        senderLid: TZVI_LID,
        text: 'מחיר',
        statusReplyToId: 'STATUS-1',
      }),
      'in-2',
    );
    await t.runTimers();
    expect(t.db.enqueued).toHaveLength(1);
    expect(t.db.callsOf('recordReplyJob').at(-1)?.[1]).toBe('skipped_cooldown');
  });

  it('R2.3 stale and R1.10 disabled automations are skipped and recorded', async () => {
    const t = setup();
    await t.sr.handle(
      t.ctx,
      inboundEvent({
        text: 'מחיר',
        statusReplyToId: 'STATUS-1',
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      'in-1',
    );
    expect(t.db.callsOf('recordReplyJob')[0]?.[1]).toBe('skipped_stale');
    t.db.automations = [automation({ enabled: false })];
    await t.sr.handle(t.ctx, inboundEvent({ text: 'מחיר', statusReplyToId: 'STATUS-1' }), 'in-2');
    expect(t.db.callsOf('recordReplyJob')[1]?.[1]).toBe('skipped_disabled');
    expect(t.db.enqueued).toHaveLength(0);
  });

  it('unbound "next status" automations never reply; invalid rows are skipped', () => {
    expect(
      toAutomation(
        automation({ provider_status_id: null, bind_mode: 'next_status', status_id: null }),
      )?.boundStatusId,
    ).toBeNull();
    expect(toAutomation(automation({ keywords: [] }))).toBeNull();
  });
});
