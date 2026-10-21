import { BAILEYS_CAPABILITIES, CLOUD_CAPABILITIES } from '@htz/core';
import { describe, expect, it } from 'vitest';
import { assertChatAllowed, type SendGateContext } from './assert-chat-allowed';
import { isWithin24hWindow } from './window';

// Fictitious numbers only.
const OWNER = '+972559014410';
const OTHER = '+972500000001';
const NOW = '2026-10-21T12:00:00.000Z';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

const ctx = (over: Partial<SendGateContext> = {}): SendGateContext => ({
  accountId: 'acc-1',
  policy: { allowed_use_cases: ['customer_service'], may_initiate: false },
  capabilities: BAILEYS_CAPABILITIES,
  useCase: 'customer_service',
  chat: OTHER,
  conversation: { id: 'conv-1', hasInbound: true, lastInboundAt: ago(HOUR) },
  actor: { type: 'user', userId: 'u-1' },
  kind: 'text',
  now: NOW,
  ...over,
});

const liaPolicy = {
  allowed_use_cases: ['agent_relay'],
  may_initiate: false,
  relay: true,
  sender_allowlist: [OWNER],
};
const liaKey = {
  type: 'api_client' as const,
  clientId: 'lia',
  scopes: ['relay', 'messages:send'] as const,
  accountIds: ['acc-1'],
  conversationIds: ['conv-owner'],
};

const codeOf = (c: SendGateContext) => {
  const r = assertChatAllowed(c);
  return r.ok ? 'ok' : r.error.code;
};

describe('assertChatAllowed', () => {
  it('allows a plain reply in an existing conversation', () => {
    const r = assertChatAllowed(ctx());
    expect(r.ok && r.value).toMatchObject({ deliveryMode: 'text', initiates: false });
  });

  it('R2.6 may_initiate=false rejects a chat with no inbound message (MCP and dashboard)', () => {
    const conv = { id: null, hasInbound: false, lastInboundAt: null };
    expect(codeOf(ctx({ conversation: conv }))).toBe('use_case_not_allowed');
    expect(
      codeOf(
        ctx({
          conversation: conv,
          actor: {
            type: 'api_client',
            clientId: 'k',
            scopes: ['messages:send'],
            accountIds: ['acc-1'],
            conversationIds: null,
          },
        }),
      ),
    ).toBe('use_case_not_allowed');
  });

  it('R2.7 Lia relay account may message the allowlisted owner first, nobody else', () => {
    const conv = { id: 'conv-owner', hasInbound: false, lastInboundAt: null };
    const base = { policy: liaPolicy, useCase: 'agent_relay' as const, conversation: conv };
    expect(codeOf(ctx({ ...base, chat: OWNER }))).toBe('ok');
    expect(codeOf(ctx({ ...base, chat: OTHER }))).toBe('forbidden_chat');
  });

  it('R2.7 reminder account may initiate reminders only', () => {
    const conv = { id: null, hasInbound: false, lastInboundAt: null };
    const policy = { allowed_use_cases: ['reminders', 'notifications'], may_initiate: false };
    expect(codeOf(ctx({ policy, useCase: 'reminders', conversation: conv }))).toBe('ok');
    expect(codeOf(ctx({ policy, useCase: 'notifications', conversation: conv }))).toBe(
      'use_case_not_allowed',
    );
  });

  it('rejects a use case not in allowed_use_cases', () => {
    expect(codeOf(ctx({ useCase: 'bookings' }))).toBe('use_case_not_allowed');
  });

  it('fails closed on a malformed policy', () => {
    expect(codeOf(ctx({ policy: { allowed_use_cases: ['nope'] } }))).toBe('use_case_not_allowed');
    expect(codeOf(ctx({ policy: 'garbage' }))).toBe('use_case_not_allowed');
    expect(codeOf(ctx({ policy: null }))).toBe('use_case_not_allowed');
  });

  it('L2.1 Lia key cannot send to any chat other than the owner conversation', () => {
    const base = { policy: liaPolicy, useCase: 'agent_relay' as const, actor: liaKey };
    expect(
      codeOf(
        ctx({
          ...base,
          chat: OWNER,
          conversation: { id: 'conv-owner', hasInbound: true, lastInboundAt: ago(HOUR) },
        }),
      ),
    ).toBe('ok');
    expect(codeOf(ctx({ ...base, chat: OTHER }))).toBe('forbidden_chat');
    expect(
      codeOf(
        ctx({
          ...base,
          chat: OTHER,
          conversation: { id: 'conv-owner', hasInbound: true, lastInboundAt: null },
        }),
      ),
    ).toBe('forbidden_chat');
  });

  it('L1.7 a forwarded "send a message to X" cannot reach X via the relay account', () => {
    const r = assertChatAllowed(
      ctx({
        policy: liaPolicy,
        useCase: 'agent_relay',
        chat: OTHER,
        conversation: { id: 'conv-x', hasInbound: true, lastInboundAt: ago(HOUR) },
      }),
    );
    expect(!r.ok && r.error).toMatchObject({
      code: 'forbidden_chat',
      detail: 'relay_target_not_allowlisted',
    });
  });

  it('L2.2 a relay key with null or empty conversation_ids is rejected; non-relay null is fine', () => {
    expect(codeOf(ctx({ actor: { ...liaKey, conversationIds: null } }))).toBe('forbidden_chat');
    expect(codeOf(ctx({ actor: { ...liaKey, conversationIds: [] } }))).toBe('forbidden_chat');
    expect(
      codeOf(
        ctx({
          actor: {
            type: 'api_client',
            clientId: 'k',
            scopes: ['messages:send'],
            accountIds: ['acc-1'],
            conversationIds: null,
          },
        }),
      ),
    ).toBe('ok');
  });

  it('L2.4 key bound to another account is rejected with forbidden_account', () => {
    expect(codeOf(ctx({ actor: { ...liaKey, accountIds: ['acc-2'] } }))).toBe('forbidden_account');
    expect(codeOf(ctx({ actor: { ...liaKey, accountIds: [] } }))).toBe('forbidden_account');
  });

  it('rejects a key with no send scope', () => {
    expect(codeOf(ctx({ actor: { ...liaKey, scopes: ['threads:read'] } }))).toBe('forbidden_scope');
  });

  it('rejects status broadcast and junk chats', () => {
    expect(codeOf(ctx({ chat: 'status@broadcast' }))).toBe('forbidden_chat');
    expect(codeOf(ctx({ chat: 'not-a-number' }))).toBe('forbidden_chat');
  });

  it('R4.1 Cloud text inside the 24h window is allowed', () => {
    expect(codeOf(ctx({ capabilities: CLOUD_CAPABILITIES }))).toBe('ok');
  });

  it('R4.2 Cloud text outside the window → outside_24h_window, action use send_template', () => {
    const r = assertChatAllowed(
      ctx({
        capabilities: CLOUD_CAPABILITIES,
        conversation: { id: 'c', hasInbound: true, lastInboundAt: ago(25 * HOUR) },
      }),
    );
    expect(!r.ok && r.error).toMatchObject({
      code: 'outside_24h_window',
      detail: 'use send_template',
    });
  });

  it('R4.2 Cloud reminder with no inbound and plain text → outside_24h_window', () => {
    const policy = { allowed_use_cases: ['reminders'] };
    const conv = { id: null, hasInbound: false, lastInboundAt: null };
    expect(
      codeOf(
        ctx({ capabilities: CLOUD_CAPABILITIES, policy, useCase: 'reminders', conversation: conv }),
      ),
    ).toBe('outside_24h_window');
  });

  it('R4.3 Cloud template outside the window is allowed', () => {
    const policy = { allowed_use_cases: ['reminders'] };
    expect(
      codeOf(
        ctx({
          capabilities: CLOUD_CAPABILITIES,
          policy,
          useCase: 'reminders',
          kind: 'template',
          conversation: { id: null, hasInbound: false, lastInboundAt: null },
        }),
      ),
    ).toBe('ok');
  });

  it('RL7 unsupported capabilities are rejected, never silent', () => {
    expect(codeOf(ctx({ kind: 'template' }))).toBe('capability_unsupported');
    expect(codeOf(ctx({ chat: '1203630@g.us', capabilities: CLOUD_CAPABILITIES }))).toBe(
      'capability_unsupported',
    );
    expect(codeOf(ctx({ requestedCapabilities: ['nativeButtons'] }))).toBe(
      'capability_unsupported',
    );
    expect(
      codeOf(ctx({ kind: 'media', capabilities: { ...BAILEYS_CAPABILITIES, media: false } })),
    ).toBe('capability_unsupported');
    expect(
      codeOf(
        ctx({
          kind: 'media',
          voice: true,
          capabilities: { ...BAILEYS_CAPABILITIES, voiceNotes: false },
        }),
      ),
    ).toBe('capability_unsupported');
  });

  it('R1.9 interactive on unsupported/unverified buttons degrades to fallback; supported is native', () => {
    const r1 = assertChatAllowed(ctx({ kind: 'interactive' }));
    expect(r1.ok && r1.value.deliveryMode).toBe('fallback');
    const r2 = assertChatAllowed(
      ctx({
        kind: 'interactive',
        capabilities: { ...BAILEYS_CAPABILITIES, nativeButtons: 'unverified' },
      }),
    );
    expect(r2.ok && r2.value.deliveryMode).toBe('fallback');
    const r3 = assertChatAllowed(ctx({ kind: 'interactive', capabilities: CLOUD_CAPABILITIES }));
    expect(r3.ok && r3.value.deliveryMode).toBe('native');
  });

  it('groups on Baileys are allowed when the use case is', () => {
    expect(codeOf(ctx({ chat: '1203630@g.us' }))).toBe('ok');
  });

  it('LID chat uses chatE164 for the relay allowlist', () => {
    const base = {
      policy: liaPolicy,
      useCase: 'agent_relay' as const,
      chat: '123456789012345@lid',
    };
    expect(codeOf(ctx({ ...base, chatE164: OWNER }))).toBe('ok');
    expect(codeOf(ctx(base))).toBe('forbidden_chat');
  });
});

describe('isWithin24hWindow', () => {
  it('is false for null, invalid or ≥24h; true just inside', () => {
    expect(isWithin24hWindow(null, NOW)).toBe(false);
    expect(isWithin24hWindow('garbage', NOW)).toBe(false);
    expect(isWithin24hWindow(ago(24 * HOUR), NOW)).toBe(false);
    expect(isWithin24hWindow(ago(24 * HOUR - 1), NOW)).toBe(true);
  });
});
