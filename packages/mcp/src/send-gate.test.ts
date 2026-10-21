import { describe, expect, it } from 'vitest';
import { err, gatewayError } from '@htz/core';
import { authCtx, runtimeFor, seededDeps, VALID_ARGS } from './test-helpers';
import { SEND_TOOLS, TOOL_NAMES } from './tools';
import { conversationBindingGate, TEST_JID } from './testing';

describe('single send gate', () => {
  it('S13 the send-tool list covers every tool that has an outbound effect', () => {
    expect([...SEND_TOOLS].sort()).toEqual(
      [
        'mark_read',
        'resend_message',
        'send_group_message',
        'send_media',
        'send_message',
        'send_reminder',
        'send_template',
        'update_reply',
      ].sort(),
    );
    for (const t of SEND_TOOLS) expect(TOOL_NAMES).toContain(t);
  });

  it.each(SEND_TOOLS)(
    'S13 %s calls the gate exactly once (intent send) before its side effect',
    async (tool) => {
      const f = seededDeps();
      const r = await runtimeFor(f).callTool(tool, VALID_ARGS[tool]);
      expect(r.isError, JSON.stringify(r.payload)).toBe(false);
      expect(f.gate.calls).toHaveLength(1);
      expect(f.gate.calls[0]).toMatchObject({ intent: 'send', tool, apiClientId: 'key-1' });
      expect(f.sideEffects()).toBe(1);
    },
  );

  it.each(SEND_TOOLS)(
    'S13/L2.1 %s: a gate rejection causes zero side effects and is audited',
    async (tool) => {
      const f = seededDeps();
      f.gate.decide = () => err(gatewayError('forbidden_chat', 'chat_not_bound'));
      const r = await runtimeFor(f).callTool(tool, VALID_ARGS[tool]);
      expect(r.isError).toBe(true);
      expect(r.payload).toMatchObject({ ok: false, code: 'forbidden_chat' });
      expect(f.gate.calls).toHaveLength(1);
      expect(f.sideEffects()).toBe(0);
      expect(f.audit.entries.at(-1)).toMatchObject({
        action: `mcp.${tool}`,
        outcome: 'rejected',
        code: 'forbidden_chat',
      });
    },
  );

  it.each(SEND_TOOLS)('L2.3 %s: a throwing gate fails closed', async (tool) => {
    const f = seededDeps();
    f.gate.decide = () => {
      throw new Error('policy db down');
    };
    const r = await runtimeFor(f).callTool(tool, VALID_ARGS[tool]);
    expect(r.payload).toMatchObject({ ok: false, code: 'internal' });
    expect(f.sideEffects()).toBe(0);
  });

  it('L2.1 a conversation-bound (Lia) key cannot send, edit, read or remind to another chat', async () => {
    const f = seededDeps();
    f.gate.decide = conversationBindingGate({ [TEST_JID]: 'conv-tzvi' });
    const rt = runtimeFor(f, authCtx({ conversationIds: ['conv-tzvi'] }));
    const other = '0559014411';
    for (const [tool, args] of [
      ['send_message', { to: other, text: 'x' }],
      ['send_media', { to: other, url: 'https://cdn.example.test/a.jpg', mime: 'image/jpeg' }],
      ['send_reminder', { to: other, text: 'x' }],
      ['get_thread', { chat: other }],
      ['get_messages', { chat: other }],
    ] as const) {
      const r = await rt.callTool(tool, args);
      expect(r.payload, tool).toMatchObject({ ok: false, code: 'forbidden_chat' });
    }
    // update_reply / get_message on a message in another chat
    f.messages.seed({
      id: 'msg-other',
      accountId: 'acc-baileys',
      chat: '972559014411@s.whatsapp.net',
    });
    for (const tool of ['update_reply', 'get_message'] as const) {
      const r = await rt.callTool(tool, { message_id: 'msg-other', text: 'x' });
      expect(r.payload, tool).toMatchObject({ ok: false, code: 'forbidden_chat' });
    }
    expect(f.sideEffects()).toBe(0);
    // ...while the bound chat works
    const okR = await rt.callTool('send_message', { to: '0559014410', text: 'hi' });
    expect(okR.isError).toBe(false);
  });

  it('S8 per-key send rate limit returns rate_limited with retry_after and no side effect', async () => {
    const f = seededDeps();
    f.rateLimiter.deny.set('send:key-1', 7_000);
    const r = await runtimeFor(f).callTool('send_message', VALID_ARGS.send_message);
    expect(r.payload).toMatchObject({
      ok: false,
      code: 'rate_limited',
      retry_after: 7,
      action: 'retry_later',
    });
    expect(f.gate.calls).toHaveLength(0);
    expect(f.sideEffects()).toBe(0);
  });
});
