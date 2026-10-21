import { z } from 'zod';
import { contactKeys, cooldownKey, type LidPnResolver } from './jid';
import { matchConfigSchema, matchKeyword } from './matcher';
import { planPacing, type PacingPlan, type PacingSettings } from './pacing';
import {
  DEFAULT_PROTECTION,
  isCooldownActive,
  isDailyCapReached,
  isDirectChat,
  isStale,
  type ProtectionSettings,
  type SkipReason,
} from './protection';
import {
  renderReply,
  replyConfigSchema,
  type RenderedReply,
  type ReplyCapabilities,
} from './reply';
import { statusBindingSchema } from './status-binding';

/** A status-reply automation as validated at the edge (DB row / MCP input). */
export const automationSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  match: matchConfigSchema,
  reply: replyConfigSchema,
  binding: statusBindingSchema,
});
export type Automation = z.infer<typeof automationSchema>;

/** A reply someone sent to one of the account's statuses. */
export interface StatusReplyMessage {
  chatJid: string;
  isGroup: boolean;
  fromMe: boolean;
  senderPn: string | null;
  senderLid: string | null;
  text: string | null;
  timestamp: string;
  /** Id of the status being replied to; null for ordinary messages. */
  statusReplyToId: string | null;
  pushName: string | null;
}

export interface StatusReplyState {
  /** Cooldown keys already used (see `cooldownKey`). */
  usedCooldownKeys: ReadonlySet<string>;
  /** Timestamps of automated sends on this account (for the daily cap). */
  sendTimestamps: readonly string[];
  lastSentAt: string | null;
}

export interface StatusReplyInput {
  automation: Automation;
  /** For `next` bindings: the status resolved by `resolveBoundStatus` (null = not bound yet). */
  boundStatusId: string | null;
  message: StatusReplyMessage;
  now: Date | string | number;
  state: StatusReplyState;
  capabilities: ReplyCapabilities;
  resolver: LidPnResolver;
  rng: () => number;
  protection?: Partial<ProtectionSettings>;
  pacing?: Partial<PacingSettings>;
}

export type StatusReplyDecision =
  | { action: 'skip'; reason: SkipReason; automationId: string }
  | {
      action: 'reply';
      reason: 'matched';
      automationId: string;
      keyword: string;
      statusId: string;
      /** Same direct chat the reply came from. */
      to: string;
      reply: RenderedReply;
      pacing: PacingPlan;
      /** Record all of these once the send is committed. */
      cooldownKeys: string[];
    };

/**
 * Pure status-reply engine (ARCH §9.3, TEST-PLAN R1/R2). No I/O: the worker loads state,
 * calls this, then executes the plan (mark read → typing → send through the send gate)
 * and records `cooldownKeys` + the send timestamp.
 */
export function evaluateStatusReply(input: StatusReplyInput): StatusReplyDecision {
  const { automation: a, message: m } = input;
  const now = new Date(input.now).getTime();
  const protection = { ...DEFAULT_PROTECTION, ...input.protection };
  const skip = (reason: SkipReason): StatusReplyDecision => ({
    action: 'skip',
    reason,
    automationId: a.id,
  });

  if (!a.enabled) return skip('skipped_disabled');
  if (m.fromMe) return skip('skipped_from_me');
  if (!isDirectChat(m.chatJid, m.isGroup)) return skip('skipped_not_direct');
  if (!m.statusReplyToId) return skip('skipped_not_status_reply');

  const statusId = a.binding.mode === 'specific' ? a.binding.statusId : input.boundStatusId;
  if (!statusId || statusId !== m.statusReplyToId) return skip('skipped_status_mismatch');

  if (isStale(m.timestamp, now, protection.maxAgeMs)) return skip('skipped_stale');

  const match = matchKeyword(m.text, a.match);
  if (!match.matched) return skip('skipped_no_match');

  const ids = contactKeys(m.senderPn, m.senderLid, input.resolver);
  if (ids.length === 0) return skip('skipped_not_direct');
  const keys = ids.map((k) => cooldownKey(a.id, statusId, k));
  if (isCooldownActive(keys, input.state.usedCooldownKeys)) return skip('skipped_cooldown');

  if (isDailyCapReached(input.state.sendTimestamps, now, protection)) return skip('skipped_cap');

  const lastSent = input.state.lastSentAt === null ? null : Date.parse(input.state.lastSentAt);
  return {
    action: 'reply',
    reason: 'matched',
    automationId: a.id,
    keyword: match.keyword,
    statusId,
    to: m.chatJid,
    reply: renderReply(a.reply, { pushName: m.pushName, capabilities: input.capabilities }),
    pacing: planPacing({
      now,
      lastSentAt: lastSent !== null && Number.isFinite(lastSent) ? lastSent : null,
      rng: input.rng,
      ...(input.pacing ? { settings: input.pacing } : {}),
    }),
    cooldownKeys: keys,
  };
}

/**
 * Evaluate several automations for one message; the first `reply` wins (one reply per
 * contact per status). Returns that decision, or every skip for the activity log.
 */
export function evaluateStatusReplies(
  automations: readonly { automation: Automation; boundStatusId: string | null }[],
  base: Omit<StatusReplyInput, 'automation' | 'boundStatusId'>,
): {
  reply: Extract<StatusReplyDecision, { action: 'reply' }> | null;
  skips: StatusReplyDecision[];
} {
  const skips: StatusReplyDecision[] = [];
  for (const { automation, boundStatusId } of automations) {
    const d = evaluateStatusReply({ ...base, automation, boundStatusId });
    if (d.action === 'reply') return { reply: d, skips };
    skips.push(d);
  }
  return { reply: null, skips };
}
