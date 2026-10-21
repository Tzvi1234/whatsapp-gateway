import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, OutboundMessage, SendResult } from '@htz/core';
import { SEND_ENTRY_POINTS, createRecordingSendGate, type SendEntryPoint } from '@htz/policy';
import { Pacer } from '@htz/provider-baileys';
import { nullChangeFeed } from '../db/realtime';
import type { ClaimedJob } from '../db/types';
import { createAccountDirectory } from '../session/accounts';
import {
  ACC,
  FakeDb,
  ORG,
  TZVI_E164,
  TZVI_LID,
  TZVI_PN,
  relayAccount,
  relayTarget,
  silentLogger,
  uuid,
} from '../test/fakes';
import { createOutbox } from './outbox';
import { QueueProcessor, entryPointForJob, type QueueDeps } from './processor';
import { createQueueRunner } from './queue';

const CONV = '00000000-0000-4000-8000-0000000000c1';

function job(over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    job_id: uuid(),
    message_id: uuid(),
    account_id: ACC,
    conversation_id: CONV,
    chat_jid: TZVI_PN,
    attempts: 1,
    lease_until: new Date(Date.now() + 60_000).toISOString(),
    kind: 'text',
    body: '**hi**',
    media_path: null,
    media_mime: null,
    template: null,
    quoted_provider_id: null,
    provider_message_id: null,
    idempotency_key: 'k1',
    use_case: 'agent_relay',
    delivery_mode: null,
    ...over,
  };
}

function setup(
  opts: {
    state?: ConnectionState;
    sendResult?: SendResult;
    pacer?: Pacer | null;
    policy?: Record<string, unknown>;
    wasSent?: boolean | null;
  } = {},
) {
  const db = new FakeDb();
  db.accounts.set(
    ACC,
    relayAccount({
      use_case_policy: opts.policy ?? {
        allowed_use_cases: ['agent_relay', 'status_automation', 'reminders', 'notifications'],
        may_initiate: false,
        relay: true,
      },
    }),
  );
  db.targets.push(relayTarget({ allowed_senders: [TZVI_E164] }));
  db.conversations.set(CONV, {
    id: CONV,
    account_id: ACC,
    chat_jid: TZVI_PN,
    type: 'direct',
    last_inbound_at: new Date().toISOString(),
  });
  const sent: OutboundMessage[] = [];
  const gate = createRecordingSendGate();
  const order: string[] = [];
  const recordingGate = {
    ...gate,
    check: (e: SendEntryPoint, c: Parameters<typeof gate.check>[1]) => {
      order.push(`gate:${e}`);
      return gate.check(e, c);
    },
  };
  const provider = {
    send: vi.fn(async (m: OutboundMessage, _opts?: { messageId?: string }) => {
      order.push('send');
      sent.push(m);
      return (
        opts.sendResult ?? {
          ok: true,
          providerMessageId: 'WA-OUT-1',
          deliveryMode: 'text' as const,
        }
      );
    }),
    setPresence: vi.fn(async () => undefined),
    newMessageId: vi.fn(() => '3EB0GENERATED'),
    wasSent: vi.fn(async (): Promise<boolean | null> =>
      opts.wasSent === undefined ? false : opts.wasSent,
    ),
  };
  const deps: QueueDeps = {
    db,
    gate: recordingGate,
    provider,
    accounts: createAccountDirectory(db, { seed: [] }),
    sessionState: () => opts.state ?? 'open',
    resolveChatE164: async (_a, chat) => (chat === TZVI_LID ? TZVI_E164 : null),
    pacer: opts.pacer ?? null,
    workerId: 'w1',
    orgId: ORG,
    log: silentLogger(),
    sleep: async () => undefined,
  };
  return { db, gate, provider, sent, order, processor: new QueueProcessor(deps), deps };
}

afterEach(() => vi.useRealTimers());

describe('QueueProcessor', () => {
  it('RL2 reserved id already sent from this device → completed without resending', async () => {
    const { db, provider, processor } = setup({ wasSent: true });
    const out = await processor.process(job({ provider_message_id: 'WA-EXISTING' }));
    expect(out).toBe('completed_existing');
    expect(provider.wasSent).toHaveBeenCalledWith(ACC, 'WA-EXISTING');
    expect(provider.send).not.toHaveBeenCalled();
    expect(db.callsOf('completeJob')[0]?.[1]).toBe('WA-EXISTING');
  });

  it('RL2 reserved but never sent → resent with the SAME id (no new reservation), then completed', async () => {
    const { db, provider, processor } = setup({
      wasSent: false,
      sendResult: { ok: true, providerMessageId: 'WA-RESERVED', deliveryMode: 'text' },
    });
    const out = await processor.process(job({ provider_message_id: 'WA-RESERVED' }));
    expect(out).toBe('sent');
    expect(provider.send).toHaveBeenCalledOnce();
    expect(provider.send.mock.calls[0]?.[1]).toEqual({ messageId: 'WA-RESERVED' });
    expect(db.callsOf('reserveProviderId')).toHaveLength(0);
    expect(db.callsOf('completeJob')[0]?.[1]).toBe('WA-RESERVED');
  });

  it('RL2 reserved id but no session can verify it → transient retry, never a blind resend', async () => {
    const { db, provider, processor } = setup({ wasSent: null });
    expect(await processor.process(job({ provider_message_id: 'WA-RESERVED' }))).toBe(
      'rescheduled',
    );
    expect(provider.send).not.toHaveBeenCalled();
    expect(db.callsOf('failJob')[0]?.slice(1, 4)).toEqual([
      'session_disconnected',
      true,
      'rl2_unverified',
    ]);
  });

  it('RL2 fresh job: id generated → job_reserve_provider_id → send with that id → complete_job', async () => {
    const { db, provider, processor, order } = setup({
      sendResult: { ok: true, providerMessageId: '3EB0GENERATED', deliveryMode: 'text' },
    });
    const j = job();
    expect(await processor.process(j)).toBe('sent');
    expect(db.callsOf('reserveProviderId')[0]).toEqual([j.job_id, 'w1', '3EB0GENERATED']);
    expect(provider.send.mock.calls[0]?.[1]).toEqual({ messageId: '3EB0GENERATED' });
    expect(order).toEqual(['gate:relay.reply', 'send']);
    const reserveAt = db.calls.findIndex((c) => c.fn === 'reserveProviderId');
    const completeAt = db.calls.findIndex((c) => c.fn === 'completeJob');
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    expect(completeAt).toBeGreaterThan(reserveAt);
  });

  it('RL2 reservation refused (lease lost) → nothing sent', async () => {
    const { db, provider, processor } = setup();
    db.reserveProviderId = async () => false;
    expect(await processor.process(job())).toBe('lease_lost');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('sends through the gate and completes with the provider id; Lia Markdown is converted (L3.11)', async () => {
    const { db, sent, order, processor } = setup();
    expect(await processor.process(job())).toBe('sent');
    expect(order).toEqual(['gate:relay.reply', 'send']);
    expect(sent[0]?.text).toBe('*hi*');
    expect(db.callsOf('completeJob')[0]?.[1]).toBe('WA-OUT-1');
  });

  it('L1.7/L2.1 relay reply to a non-allowlisted chat is rejected by the gate and never sent', async () => {
    const { db, provider, processor } = setup();
    const out = await processor.process(job({ chat_jid: '972500000001@s.whatsapp.net' }));
    expect(out).toBe('gate_rejected');
    expect(provider.send).not.toHaveBeenCalled();
    expect(db.callsOf('failJob')[0]?.slice(1, 3)).toEqual(['forbidden_chat', false]);
  });

  it('relay reply to Tzvi as LID passes the gate via lid-mapping (L1.2)', async () => {
    const { processor, sent } = setup();
    expect(await processor.process(job({ chat_jid: TZVI_LID }))).toBe('sent');
    expect(sent[0]?.to).toBe(TZVI_LID);
  });

  it('L4.6 session down → transient session_disconnected; needs_relink → permanent + relay batch delivery_failed', async () => {
    const a = setup({ state: 'connecting' });
    expect(await a.processor.process(job())).toBe('rescheduled');
    expect(a.db.callsOf('failJob')[0]?.slice(1, 3)).toEqual(['session_disconnected', true]);
    expect(a.provider.send).not.toHaveBeenCalled();

    const b = setup({ state: 'needs_relink' });
    const j = job();
    expect(await b.processor.process(j)).toBe('failed');
    expect(b.db.callsOf('failJob')[0]?.slice(1, 3)).toEqual(['needs_relink', false]);
    // L4.6: the worker itself marks the batch delivery_failed via its own RPC (no audit workaround).
    expect(b.db.callsOf('relayDeliveryFailed')[0]).toEqual([j.message_id]);
    expect(b.db.callsOf('auditAppend')).toHaveLength(0);
  });

  it('pacing waits are chunked with lease renewals; a lost lease aborts before sending', async () => {
    const pacer = new Pacer({ jitterMinMs: 45_000, jitterMaxMs: 45_000 });
    const a = setup({ pacer });
    expect(await a.processor.process(job())).toBe('sent');
    expect(a.db.callsOf('renewLease').length).toBeGreaterThanOrEqual(3);

    const b = setup({ pacer: new Pacer({ jitterMinMs: 45_000, jitterMaxMs: 45_000 }) });
    b.db.renewResult = null;
    expect(await b.processor.process(job())).toBe('lease_lost');
    expect(b.provider.send).not.toHaveBeenCalled();
  });

  it('pacing longer than the inline limit is rescheduled, not slept', async () => {
    const { db, provider, processor } = setup({
      pacer: new Pacer({ jitterMinMs: 120_000, jitterMaxMs: 120_000 }),
    });
    expect(await processor.process(job())).toBe('rescheduled');
    expect(provider.send).not.toHaveBeenCalled();
    expect(db.callsOf('failJob')[0]?.slice(1, 3)).toEqual(['rate_limited', true]);
  });

  it('provider failure maps to fail_job with the provider code/transience', async () => {
    const { db, processor } = setup({
      sendResult: {
        ok: false,
        error: { code: 'invalid_number', transient: false, detail: 'wa_404' },
      },
    });
    expect(await processor.process(job())).toBe('failed');
    expect(db.callsOf('failJob')[0]?.slice(1, 4)).toEqual(['invalid_number', false, 'wa_404']);
  });

  it('S13 every worker send path goes through the shared gate before the provider', async () => {
    const { gate, order, db, processor } = setup();
    const outbox = createOutbox({ db, wake: () => undefined, log: silentLogger() });
    // Paths the worker itself originates: relay system replies and status replies (via the Outbox).
    await outbox.systemReply(ACC, TZVI_PN, 'קיבלתי הקלטה, מתמלל', 'voice-ack:b1');
    await outbox.statusReply(
      ACC,
      TZVI_PN,
      { text: 'תודה', media: null, deliveryMode: 'text' },
      'a1:m1',
    );
    const enqueuedJobs = db.enqueued.map((e) =>
      job({
        idempotency_key: e.p_idempotency_key ?? null,
        use_case: e.p_use_case ?? null,
        body: e.p_body ?? null,
      }),
    );
    // Paths that arrive from the server: Lia replies, reminders, MCP sends.
    const all = [
      ...enqueuedJobs,
      job({ use_case: 'agent_relay', idempotency_key: 'mcp-1' }),
      job({ use_case: 'reminders', idempotency_key: 'rem-1' }),
      job({ use_case: 'notifications', idempotency_key: 'mcp-2' }),
    ];
    db.jobs.push(...all);
    await processor.runOnce();
    const workerPaths: SendEntryPoint[] = [
      'relay.reply',
      'relay.system_reply',
      'automations.status_reply',
      'reminders.dispatch',
    ];
    expect(gate.ungated(workerPaths)).toEqual([]);
    // Every send is immediately preceded by a gate check.
    order.forEach((step, i) => {
      if (step === 'send') expect(order[i - 1]).toMatch(/^gate:/);
    });
    expect(order.filter((s) => s === 'send').length).toBeLessThanOrEqual(
      order.filter((s) => s.startsWith('gate:')).length,
    );
    expect(workerPaths.every((p) => (SEND_ENTRY_POINTS as readonly string[]).includes(p))).toBe(
      true,
    );
  });

  it('S13 entry points are derived from worker key prefixes and use cases', () => {
    expect(entryPointForJob({ idempotency_key: 'relay-sys:x', use_case: 'agent_relay' })).toBe(
      'relay.system_reply',
    );
    expect(
      entryPointForJob({ idempotency_key: 'status-reply:x', use_case: 'status_automation' }),
    ).toBe('automations.status_reply');
    expect(entryPointForJob({ idempotency_key: null, use_case: 'agent_relay' })).toBe(
      'relay.reply',
    );
    expect(entryPointForJob({ idempotency_key: null, use_case: 'reminders' })).toBe(
      'reminders.dispatch',
    );
    expect(entryPointForJob({ idempotency_key: null, use_case: null })).toBe('mcp.send_message');
  });
});

describe('queue runner', () => {
  it('RL1 with Realtime down the worker still claims jobs via the 30-60 s poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { db, processor } = setup();
    const runner = createQueueRunner({ processor, feed: nullChangeFeed, pollIntervalMs: 45_000 });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    const claimsAtStart = db.callsOf('claimJobs').length;
    db.jobs.push(job());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(db.callsOf('claimJobs').length).toBeGreaterThan(claimsAtStart);
    expect(db.callsOf('completeJob').length).toBe(1);
    await runner.stop();
  });

  it('a Realtime INSERT wakes the queue immediately', async () => {
    const { db, processor } = setup();
    let fire: () => void = () => undefined;
    const feed = { onInsert: (_t: string, cb: () => void) => ((fire = cb), async () => undefined) };
    const runner = createQueueRunner({ processor, feed, pollIntervalMs: 60_000 });
    runner.start();
    await runner.wake();
    db.jobs.push(job());
    fire();
    await runner.wake();
    expect(db.callsOf('completeJob').length).toBe(1);
    await runner.stop();
  });
});
