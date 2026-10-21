import { describe, expect, it } from 'vitest';
import { LEGACY_SCOPES, type Scope } from '@htz/core';
import { ERROR_MESSAGES } from './errors';
import { authCtx, runtimeFor, seededDeps, VALID_ARGS } from './test-helpers';
import { LEGACY_TOOL_NAMES, TOOL_NAMES, TOOL_SCOPES } from './tools';
import { TEST_JID } from './testing';

describe('legacy v1 tools', () => {
  it.each(LEGACY_TOOL_NAMES)(
    'R3.1 %s works with legacy params only and a legacy-scoped key',
    async (tool) => {
      const f = seededDeps();
      const rt = runtimeFor(f, authCtx({ scopes: new Set<Scope>(LEGACY_SCOPES), legacy: true }));
      const r = await rt.callTool(tool, VALID_ARGS[tool]);
      expect(r.isError, JSON.stringify(r.payload)).toBe(false);
      expect(r.payload.ok).toBe(true);
    },
  );

  it('R3.2 without account, Baileys tools resolve to `default` and reminders to `meta-default`', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    await rt.callTool('send_message', VALID_ARGS.send_message);
    await rt.callTool('send_reminder', VALID_ARGS.send_reminder);
    expect(f.messages.effects[0]!.req).toMatchObject({ accountId: 'acc-baileys', chat: TEST_JID });
    expect(f.reminders.items.at(-1)).toMatchObject({ accountId: 'acc-cloud', chat: TEST_JID });
    const caps = await rt.callTool('get_capabilities', {});
    expect(caps.payload).toMatchObject({ ok: true, account: 'default', provider: 'baileys' });
  });

  it('R3.2 falls back to the other alias when the key is bound only to it', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f, authCtx({ accountIds: ['acc-cloud'] }));
    const r = await rt.callTool('session_status', {});
    expect(r.payload).toMatchObject({ ok: true, account: 'meta-default' });
  });

  it('L2.4 an explicit account the key is not bound to is rejected', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f, authCtx({ accountIds: ['acc-baileys'] }));
    const r = await rt.callTool('send_message', {
      ...VALID_ARGS.send_message,
      account: 'meta-default',
    });
    expect(r.payload).toMatchObject({ ok: false, code: 'forbidden_account' });
    expect(f.sideEffects()).toBe(0);
    const unknown = await rt.callTool('send_message', {
      ...VALID_ARGS.send_message,
      account: 'nope',
    });
    expect(unknown.payload).toMatchObject({ ok: false, code: 'not_found' });
  });

  it.each(TOOL_NAMES)(
    'R3.4 %s without its scope is rejected, has no side effect and is audited',
    async (tool) => {
      const f = seededDeps();
      const scopes = new Set<Scope>(authCtx().scopes);
      scopes.delete(TOOL_SCOPES[tool]);
      const r = await runtimeFor(f, authCtx({ scopes })).callTool(tool, VALID_ARGS[tool]);
      expect(r.payload).toMatchObject({
        ok: false,
        code: 'forbidden_scope',
        detail: TOOL_SCOPES[tool],
      });
      expect(f.sideEffects()).toBe(0);
      expect(f.gate.calls).toHaveLength(0);
      expect(f.audit.entries).toHaveLength(1);
      expect(f.audit.entries[0]).toMatchObject({
        action: `mcp.${tool}`,
        outcome: 'rejected',
        code: 'forbidden_scope',
        actorId: 'key-1',
      });
    },
  );

  it('L2.4 a relay key (no session scopes) cannot use session tools', async () => {
    const f = seededDeps();
    const rt = runtimeFor(
      f,
      authCtx({
        scopes: new Set<Scope>(['relay', 'messages:send', 'threads:read']),
        conversationIds: ['c1'],
      }),
    );
    for (const tool of ['session_status', 'session_reconnect'] as const) {
      expect((await rt.callTool(tool, {})).payload).toMatchObject({ code: 'forbidden_scope' });
    }
    expect(f.sessions.commands).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('R3.5 same client_msg_id twice (sequential) → one send, same result', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    const args = { ...VALID_ARGS.send_message, client_msg_id: 'c-1', reply_to_id: 'wamid.Q' };
    const a = await rt.callTool('send_message', args);
    const b = await rt.callTool('send_message', args);
    expect(f.messages.effects).toHaveLength(1);
    expect(a.payload).toMatchObject({ ok: true, duplicate: false });
    expect(b.payload).toMatchObject({
      ok: true,
      duplicate: true,
      message_id: (a.payload as unknown as { message_id: string }).message_id,
    });
    expect(f.messages.effects[0]!.req).toMatchObject({
      replyToId: 'wamid.Q',
      clientMsgId: 'c-1',
      idempotencyKey: 'c-1',
    });
  });

  it('R3.5 same client_msg_id twice (concurrent) → one send, same message id', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    const args = { ...VALID_ARGS.send_message, client_msg_id: 'c-2' };
    const [a, b] = await Promise.all([
      rt.callTool('send_message', args),
      rt.callTool('send_message', args),
    ]);
    expect(f.messages.effects).toHaveLength(1);
    const ids = [a, b].map((r) => (r.payload as unknown as { message_id: string }).message_id);
    expect(ids[0]).toBe(ids[1]);
    expect(
      [a, b].map((r) => (r.payload as unknown as { duplicate: boolean }).duplicate).sort(),
    ).toEqual([false, true]);
  });

  it('R3.6 without client_msg_id: no dedup, logged as such', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    await rt.callTool('send_message', VALID_ARGS.send_message);
    await rt.callTool('send_message', VALID_ARGS.send_message);
    expect(f.messages.effects).toHaveLength(2);
    expect(f.audit.entries.map((e) => e.meta.dedup)).toEqual([false, false]);
    const keys = f.messages.effects.map(
      (e) => (e.req as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });
});

describe('outputs, errors, audit', () => {
  it('R3.8 session_status never contains QR, auth state or tokens', async () => {
    const f = seededDeps();
    f.sessions.leakSecrets = true;
    const r = await runtimeFor(f).callTool('session_status', {});
    const s = JSON.stringify(r.payload);
    expect(r.isError).toBe(false);
    expect(s).not.toMatch(/qr|QRPAYLOAD|authState|noiseKey|accessToken|EAAG/);
    expect(r.payload).toMatchObject({ session: { connection: 'open', provider: 'baileys' } });
  });

  it('session_reconnect inserts a command', async () => {
    const f = seededDeps();
    const r = await runtimeFor(f).callTool('session_reconnect', {});
    expect(r.payload).toMatchObject({ ok: true, requested: true });
    expect(f.sessions.commands).toEqual([{ accountId: 'acc-baileys', requestedBy: 'key-1' }]);
  });

  it('errors carry Hebrew + English messages and an action', async () => {
    const f = seededDeps();
    const r = await runtimeFor(f).callTool('send_template', {
      ...VALID_ARGS.send_template,
      account: 'default',
    });
    expect(r.payload).toEqual({
      ok: false,
      code: 'capability_unsupported',
      message_he: ERROR_MESSAGES.capability_unsupported.he,
      message_en: ERROR_MESSAGES.capability_unsupported.en,
      action: null,
      detail: 'templates_not_supported',
    });
    for (const m of Object.values(ERROR_MESSAGES)) expect(m.he).toMatch(/[֐-׿]/);
  });

  it('RL7 unsupported capabilities are rejected, never silent', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    for (const [tool, args] of [
      ['list_groups', { account: 'meta-default' }],
      ['send_group_message', { ...VALID_ARGS.send_group_message, account: 'meta-default' }],
      ['send_message', { to: '120363000000000001@g.us', text: 'x', account: 'meta-default' }],
      ['list_templates', { account: 'default' }],
      ['create_automation', { ...VALID_ARGS.create_automation, account: 'meta-default' }],
    ] as const) {
      expect((await rt.callTool(tool, args)).payload, tool).toMatchObject({
        code: 'capability_unsupported',
      });
    }
    expect(f.sideEffects()).toBe(0);
  });

  it('invalid params → invalid_input with the failing field, no side effect', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    expect((await rt.callTool('send_message', { to: '0559014410' })).payload).toMatchObject({
      code: 'invalid_input',
      detail: 'invalid_text',
    });
    expect(
      (await rt.callTool('send_message', { to: 'not-a-number', text: 'x' })).payload,
    ).toMatchObject({ code: 'invalid_number' });
    expect(
      (
        await rt.callTool('send_media', {
          to: '0559014410',
          url: 'http://x.test/a',
          mime: 'image/png',
        })
      ).payload,
    ).toMatchObject({ code: 'invalid_input' });
    expect(
      (
        await rt.callTool('create_automation', {
          ...VALID_ARGS.create_automation,
          options: Array(11).fill('o'),
        })
      ).payload,
    ).toMatchObject({ code: 'invalid_input' });
    expect((await rt.callTool('nope', {})).payload).toMatchObject({ code: 'not_found' });
    expect(f.sideEffects()).toBe(0);
  });

  it('R4.6 cancel after send is rejected with a clear reason', async () => {
    const f = seededDeps();
    f.reminders.items[0]!.state = 'sent';
    const r = await runtimeFor(f).callTool('cancel_reminder', { id: 'rem-1' });
    expect(r.payload).toMatchObject({ ok: false, code: 'conflict', detail: 'already_sent' });
  });

  it('resend only for failed messages; get_messages pages with a cursor', async () => {
    const f = seededDeps();
    const rt = runtimeFor(f);
    f.messages.seed({
      id: 'msg-ok',
      accountId: 'acc-baileys',
      chat: TEST_JID,
      status: 'delivered',
    });
    expect((await rt.callTool('resend_message', { message_id: 'msg-ok' })).payload).toMatchObject({
      code: 'conflict',
    });
    const p1 = await rt.callTool('get_messages', { chat: '0559014410', limit: 1 });
    expect(p1.payload).toMatchObject({ ok: true, next_cursor: '1' });
    const p2 = await rt.callTool('get_messages', { chat: '0559014410', limit: 1, cursor: '1' });
    expect(p2.payload).toMatchObject({ ok: true, next_cursor: null });
  });

  it('audit redacts bodies and masks numbers', async () => {
    const f = seededDeps();
    await runtimeFor(f).callTool('send_message', {
      to: '0559014410',
      text: 'סוד גדול',
      client_msg_id: 'c-9',
    });
    const e = f.audit.entries[0]!;
    const s = JSON.stringify(e);
    expect(s).not.toContain('סוד גדול');
    expect(s).not.toContain('0559014410');
    expect(e).toMatchObject({
      action: 'mcp.send_message',
      outcome: 'ok',
      target: 'acc-baileys',
      ip: '203.0.113.7',
      requestId: 'req-1',
    });
    expect(e.meta.args).toMatchObject({ to: '…4410', text: { len: 8 }, client_msg_id: 'c-9' });
  });

  it('list_accounts returns only bound accounts', async () => {
    const f = seededDeps();
    const r = await runtimeFor(f, authCtx({ accountIds: ['acc-cloud'] })).callTool(
      'list_accounts',
      {},
    );
    expect(
      (r.payload as unknown as { accounts: { id: string }[] }).accounts.map((a) => a.id),
    ).toEqual(['acc-cloud']);
  });
});
