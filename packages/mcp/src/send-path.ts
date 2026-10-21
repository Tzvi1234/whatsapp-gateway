import { err, gatewayError, normalizeJid, ok, type Result, type UseCase } from '@htz/core';
import type { ToolContext } from './context';
import type { SendGateContext } from './deps';

/**
 * THE shared send path (CODE-STRUCTURE §2, TEST-PLAN S13 / L2.1). Every send-type tool calls
 * `throughSendGate` exactly once and performs its side effect only inside `effect`, which
 * runs after: chat normalisation → per-key send rate limit → `SendGate` (policy
 * `assertChatAllowed`). Any failure (including a thrown gate) stops before the effect.
 */

export interface SendSpec {
  /** Raw chat/recipient as given by the agent (or the stored chat of a message). */
  chat: string;
  kind: SendGateContext['kind'];
  useCase?: UseCase | undefined;
}

export function normalizeChat(raw: string): Result<string> {
  const j = normalizeJid(raw);
  if (!j.ok) return j;
  if (j.value.kind !== 'pn' && j.value.kind !== 'lid' && j.value.kind !== 'group') {
    return err(gatewayError('invalid_number', 'unsupported_chat_kind'));
  }
  return ok(j.value.jid);
}

async function callGate(ctx: ToolContext, gc: SendGateContext): Promise<Result<void>> {
  try {
    const r = await ctx.deps.sendGate(gc);
    if (r && typeof r === 'object' && 'ok' in r) return r;
    return err(gatewayError('internal', 'gate_bad_result', { transient: false }));
  } catch {
    // Fail closed: a broken policy check never lets a send through.
    return err(gatewayError('internal', 'gate_failed', { transient: false }));
  }
}

export async function throughSendGate<T>(
  ctx: ToolContext,
  spec: SendSpec,
  effect: (chat: string) => Promise<Result<T>>,
): Promise<Result<T>> {
  const chat = normalizeChat(spec.chat);
  if (!chat.ok) return chat;

  let rate;
  try {
    rate = await ctx.deps.rateLimiter.take(`send:${ctx.auth.apiClientId}`);
  } catch {
    return err(gatewayError('internal', 'rate_limiter_failed', { transient: true }));
  }
  if (!rate.allowed) {
    return err(gatewayError('rate_limited', 'send_rate', { retryAfterMs: rate.retryAfterMs }));
  }

  ctx.gateCalls++;
  const gate = await callGate(ctx, {
    intent: 'send',
    tool: ctx.tool,
    apiClientId: ctx.auth.apiClientId,
    accountId: ctx.account.id,
    provider: ctx.account.provider,
    chat: chat.value,
    conversationIds: ctx.auth.conversationIds,
    kind: spec.kind,
    useCase: spec.useCase ?? ctx.account.defaultUseCase,
  });
  if (!gate.ok) return gate;
  return effect(chat.value);
}

/** Chat-scoped reads (get_thread, get_messages, get_message…) use the same gate with intent `read`. */
export async function throughReadGate(ctx: ToolContext, rawChat: string): Promise<Result<string>> {
  const chat = normalizeChat(rawChat);
  if (!chat.ok) return chat;
  const gate = await callGate(ctx, {
    intent: 'read',
    tool: ctx.tool,
    apiClientId: ctx.auth.apiClientId,
    accountId: ctx.account.id,
    provider: ctx.account.provider,
    chat: chat.value,
    conversationIds: ctx.auth.conversationIds,
    kind: 'read',
    useCase: ctx.account.defaultUseCase,
  });
  if (!gate.ok) return gate;
  return chat;
}
