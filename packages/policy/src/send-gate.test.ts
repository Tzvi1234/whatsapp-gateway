import { BAILEYS_CAPABILITIES } from '@htz/core';
import { describe, expect, it } from 'vitest';
import type { SendGateContext } from './assert-chat-allowed';
import { createRecordingSendGate, createSendGate, SEND_ENTRY_POINTS } from './send-gate';

const ctx: SendGateContext = {
  accountId: 'acc-1',
  policy: { allowed_use_cases: ['customer_service'] },
  capabilities: BAILEYS_CAPABILITIES,
  useCase: 'customer_service',
  chat: '+972500000001',
  conversation: { id: 'c', hasInbound: true, lastInboundAt: '2026-10-21T11:00:00Z' },
  actor: { type: 'system', component: 'test' },
  kind: 'text',
  now: '2026-10-21T12:00:00Z',
};

describe('send gate registry', () => {
  it('S13 recording gate reports entry points that never reached the gate', () => {
    const gate = createRecordingSendGate();
    gate.check('mcp.send_message', ctx);
    gate.check('relay.reply', { ...ctx, useCase: 'bookings' });
    expect(gate.calls).toEqual([
      { entryPoint: 'mcp.send_message', allowed: true, code: null },
      { entryPoint: 'relay.reply', allowed: false, code: 'use_case_not_allowed' },
    ]);
    expect(gate.ungated()).toHaveLength(SEND_ENTRY_POINTS.length - 2);
    for (const e of SEND_ENTRY_POINTS) gate.check(e, ctx);
    expect(gate.ungated()).toEqual([]);
    gate.reset();
    expect(gate.calls).toEqual([]);
  });

  it('S13 gate decision is exactly assertChatAllowed and onCheck errors never change it', () => {
    const gate = createSendGate({
      onCheck: () => {
        throw new Error('metrics down');
      },
    });
    expect(gate.check('dashboard.send', ctx).ok).toBe(true);
    expect(gate.check('dashboard.send', { ...ctx, policy: null }).ok).toBe(false);
  });
});
