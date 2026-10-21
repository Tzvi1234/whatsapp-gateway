import {
  err,
  gatewayError,
  normalizeJid,
  ok,
  type Capabilities,
  type DeliveryMode,
  type GatewayError,
  type NormalizedJid,
  type OutboundKind,
  type Result,
  type Scope,
  type UseCase,
} from '@htz/core';
import { normalizeAllowlist, toAllowlistE164 } from './sender-allowlist';
import { isUseCaseAllowed, parseUseCasePolicy, type UseCasePolicy } from './use-case-policy';
import { isWithin24hWindow } from './window';

export type CapabilityKey = Exclude<keyof Capabilities, 'text'>;

/** Who is asking. Dashboard actions are `user`; worker/system paths (reminders, automations) are `system`. */
export type SendActor =
  | {
      type: 'api_client';
      clientId: string;
      scopes: readonly Scope[];
      accountIds: readonly string[];
      /** null = unrestricted; allowed only for keys without the `relay` scope. */
      conversationIds: readonly string[] | null;
    }
  | { type: 'user'; userId: string }
  | { type: 'system'; component: string };

export interface ConversationFacts {
  /** conversations.id when the conversation exists, else null. */
  id: string | null;
  /** At least one inbound message exists in this chat. */
  hasInbound: boolean;
  /** conversations.last_inbound_at (24h window). */
  lastInboundAt: string | null;
}

export interface SendGateContext {
  accountId: string;
  /** Raw `accounts.use_case_policy`; validated here (invalid → fail closed). */
  policy: unknown;
  capabilities: Capabilities;
  useCase: UseCase;
  /** Target chat: E.164, local number, PN/LID/group JID. Normalised here. */
  chat: string;
  /** E.164 of the target when `chat` is a LID and the mapping is known. */
  chatE164?: string | null;
  conversation: ConversationFacts;
  actor: SendActor;
  kind: OutboundKind;
  /** media kind only: a voice note. */
  voice?: boolean;
  /** interactive kind only. */
  interactiveStyle?: 'buttons' | 'list';
  /** Capabilities the caller insists on (no fallback). Must be fully supported. */
  requestedCapabilities?: readonly CapabilityKey[];
  now: Date | string | number;
}

export interface SendDecision {
  chat: NormalizedJid;
  /** `native` for real interactive, `fallback` when interactive degrades to numbered text. */
  deliveryMode: DeliveryMode;
  /** true when this send opens a conversation (no prior inbound). */
  initiates: boolean;
  policy: UseCasePolicy;
}

const SEND_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'messages:send',
  'reminders:send',
  'media:send',
  'templates:send',
  'groups:send',
  'relay',
]);

const fail = (code: GatewayError['code'], detail: string): Result<never, GatewayError> =>
  err(gatewayError(code, detail, { transient: false }));

function isFullySupported(caps: Capabilities, key: CapabilityKey): boolean {
  const v = caps[key];
  return v === true || v === 'supported' || v === 'full';
}

function checkActor(ctx: SendGateContext): Result<true, GatewayError> {
  const a = ctx.actor;
  if (a.type !== 'api_client') return ok(true);
  if (!a.scopes.some((s) => SEND_SCOPES.has(s))) return fail('forbidden_scope', 'no_send_scope');
  if (!a.accountIds.includes(ctx.accountId)) return fail('forbidden_account', 'account_not_bound');
  const isRelayKey = a.scopes.includes('relay');
  if (a.conversationIds === null) {
    return isRelayKey ? fail('forbidden_chat', 'relay_key_unbound') : ok(true);
  }
  if (a.conversationIds.length === 0) return fail('forbidden_chat', 'no_conversations_bound');
  if (!ctx.conversation.id || !a.conversationIds.includes(ctx.conversation.id)) {
    return fail('forbidden_chat', 'conversation_not_bound');
  }
  return ok(true);
}

function targetE164(chat: NormalizedJid, chatE164: string | null | undefined): string | null {
  if (chat.kind === 'pn') return chat.e164;
  if (chat.kind === 'lid' && chatE164) return toAllowlistE164(chatE164);
  return null;
}

function checkKindCapability(ctx: SendGateContext): Result<DeliveryMode, GatewayError> {
  const caps = ctx.capabilities;
  switch (ctx.kind) {
    case 'text':
      return ok('text');
    case 'media':
      if (!caps.media) return fail('capability_unsupported', 'media');
      if (ctx.voice && !caps.voiceNotes) return fail('capability_unsupported', 'voiceNotes');
      return ok('native');
    case 'template':
      return caps.templates ? ok('native') : fail('capability_unsupported', 'templates');
    case 'reaction':
      return caps.reactions ? ok('native') : fail('capability_unsupported', 'reactions');
    case 'interactive': {
      const support = ctx.interactiveStyle === 'list' ? caps.lists : caps.nativeButtons;
      return ok(support === 'supported' ? 'native' : 'fallback');
    }
  }
}

/**
 * THE single send gate (CODE-STRUCTURE §2, ARCH §7.6, TEST-PLAN R2.6/R2.7/L1.7/L2.1/R4.2/RL7).
 * Pure: takes data, does no I/O. Fails closed on anything unknown or malformed.
 *
 * Order: actor binding → target chat → use case → initiation (may_initiate + exceptions)
 * → capabilities → Cloud 24h window.
 */
export function assertChatAllowed(ctx: SendGateContext): Result<SendDecision, GatewayError> {
  const policy = parseUseCasePolicy(ctx.policy);
  if (!policy) return fail('use_case_not_allowed', 'policy_invalid');

  const actor = checkActor(ctx);
  if (!actor.ok) return actor;

  const n = normalizeJid(ctx.chat);
  if (!n.ok) return fail('forbidden_chat', 'invalid_chat');
  const chat = n.value;
  if (chat.kind !== 'pn' && chat.kind !== 'lid' && chat.kind !== 'group') {
    return fail('forbidden_chat', `chat_kind_${chat.kind}`);
  }
  if (chat.kind === 'group' && ctx.capabilities.groups !== 'full') {
    return fail('capability_unsupported', 'groups');
  }

  if (!isUseCaseAllowed(policy, ctx.useCase)) return fail('use_case_not_allowed', 'use_case');

  const allowlist = normalizeAllowlist(policy.sender_allowlist);
  const e164 = targetE164(chat, ctx.chatE164);
  const toAllowlisted = e164 !== null && allowlist.has(e164);

  // Relay (Lia) traffic only ever goes to allowlisted senders, inbound or not (L1.7, L2.1).
  if (policy.relay && ctx.useCase === 'agent_relay' && !toAllowlisted) {
    return fail('forbidden_chat', 'relay_target_not_allowlisted');
  }

  const initiates = !ctx.conversation.hasInbound;
  if (initiates) {
    const relayException = policy.relay && toAllowlisted;
    const reminderException = ctx.useCase === 'reminders';
    if (!policy.may_initiate && !relayException && !reminderException) {
      return fail('use_case_not_allowed', 'may_initiate_false');
    }
    if (!ctx.capabilities.initiateConversation) {
      return fail('capability_unsupported', 'initiateConversation');
    }
  }

  for (const key of ctx.requestedCapabilities ?? []) {
    if (!isFullySupported(ctx.capabilities, key)) return fail('capability_unsupported', key);
  }
  const mode = checkKindCapability(ctx);
  if (!mode.ok) return mode;

  if (
    !ctx.capabilities.freeFormOutside24h &&
    ctx.kind !== 'template' &&
    !isWithin24hWindow(ctx.conversation.lastInboundAt, ctx.now)
  ) {
    return fail('outside_24h_window', 'use send_template');
  }

  return ok({ chat, deliveryMode: mode.value, initiates, policy });
}
