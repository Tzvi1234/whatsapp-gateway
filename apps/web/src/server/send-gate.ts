import {
  err,
  gatewayError,
  normalizeJid,
  ok,
  type OutboundKind,
  type Result,
  type UseCase,
} from '@htz/core';
import {
  createSendGate,
  type SendActor,
  type SendDecision,
  type SendEntryPoint,
  type SendGate,
} from '@htz/policy';
import type { Db } from './supabase';
import { logInfo } from './log';
import {
  capabilitiesOf,
  defaultUseCaseOf,
  e164ForLid,
  getAccount,
  getConversation,
  type AccountRow,
} from './repo/accounts';

/**
 * Web composition of THE single send gate (CODE-STRUCTURE §2, TEST-PLAN S13, L2.1, L2.3).
 * Loads the facts `policy.assertChatAllowed` needs (account policy + capabilities,
 * conversation facts, LID→PN) and fails CLOSED on any lookup error or missing row.
 */

let policyGate: SendGate = createSendGate({
  onCheck: (c) => {
    if (!c.allowed) logInfo('send_gate_rejected', { entry: c.entryPoint, code: c.code });
  },
});

/** Test seam (S13): inject a recording gate. */
export function setPolicyGateForTests(g: SendGate | null): void {
  policyGate =
    g ??
    createSendGate({
      onCheck: (c) => {
        if (!c.allowed) logInfo('send_gate_rejected', { entry: c.entryPoint, code: c.code });
      },
    });
}

export interface GateRequest {
  entryPoint: SendEntryPoint;
  accountId: string;
  /** Raw chat (E.164 / local number / JID). */
  chat: string;
  kind: OutboundKind;
  useCase?: UseCase | undefined;
  actor: SendActor;
  voice?: boolean;
}

export interface GateOk extends SendDecision {
  account: AccountRow;
  conversationId: string | null;
}

const closed = (detail: string) =>
  err(gatewayError('internal', `gate_${detail}`, { transient: false }));

export async function checkSend(
  db: Db,
  req: GateRequest,
  now: Date = new Date(),
): Promise<Result<GateOk>> {
  try {
    const acc = await getAccount(db, req.accountId);
    if (!acc.ok) return closed('account_lookup_failed');
    if (!acc.value) return err(gatewayError('forbidden_account', 'account_not_found'));
    const account = acc.value;

    const n = normalizeJid(req.chat);
    let conversation: { id: string | null; hasInbound: boolean; lastInboundAt: string | null } = {
      id: null,
      hasInbound: false,
      lastInboundAt: null,
    };
    let chatE164: string | null = null;
    if (n.ok) {
      const c = await getConversation(db, account.id, n.value.jid);
      if (!c.ok) return closed('conversation_lookup_failed');
      if (c.value) {
        conversation = {
          id: c.value.id,
          hasInbound: c.value.last_inbound_at !== null,
          lastInboundAt: c.value.last_inbound_at,
        };
      }
      if (n.value.kind === 'lid') {
        const pn = await e164ForLid(db, account.id, n.value.jid);
        if (!pn.ok) return closed('contact_lookup_failed');
        chatE164 = pn.value;
      }
    }

    const ctx = {
      accountId: account.id,
      policy: account.use_case_policy,
      capabilities: capabilitiesOf(account),
      useCase: req.useCase ?? defaultUseCaseOf(account),
      chat: req.chat,
      chatE164,
      conversation,
      actor: req.actor,
      kind: req.kind,
      now,
      ...(req.voice !== undefined ? { voice: req.voice } : {}),
    };
    const r = policyGate.check(req.entryPoint, ctx);
    if (!r.ok) return r;
    return ok({ ...r.value, account, conversationId: conversation.id });
  } catch {
    return closed('threw');
  }
}
