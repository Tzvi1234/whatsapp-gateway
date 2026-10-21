import 'server-only';
import { randomUUID } from 'node:crypto';
import { err, gatewayError, ok, type Result, type UseCase } from '@htz/core';
import type { CloudApiProvider } from '@htz/provider-cloud';
import type { Db } from './supabase';
import { rpc } from './db';
import { checkSend } from './send-gate';
import { enqueueAndDispatch } from './outbound';
import { chatOf, getMessageRow } from './repo/messages';

/**
 * Dashboard send paths. Both go through the SAME gate as MCP (`checkSend` →
 * `policy.assertChatAllowed`), tagged `dashboard.send` / `dashboard.resend` (S13).
 */

export interface DashboardActor {
  userId: string;
  orgId: string;
}

export async function dashboardSend(
  db: Db,
  actor: DashboardActor,
  input: { accountId: string; to: string; text: string; useCase?: UseCase },
  opts: { provider?: CloudApiProvider } = {},
): Promise<Result<{ messageId: string; status: string; errorCode: string | null }>> {
  const gate = await checkSend(db, {
    entryPoint: 'dashboard.send',
    accountId: input.accountId,
    chat: input.to,
    kind: 'text',
    useCase: input.useCase,
    actor: { type: 'user', userId: actor.userId },
  });
  if (!gate.ok) return gate;
  if (gate.value.account.org_id !== actor.orgId) {
    return err(gatewayError('forbidden_account', 'other_org'));
  }
  const res = await enqueueAndDispatch(
    db,
    {
      accountId: gate.value.account.id,
      provider: gate.value.account.provider,
      chat: gate.value.chat.jid,
      kind: 'text',
      text: input.text,
      useCase: input.useCase ?? gate.value.policy.allowed_use_cases[0] ?? 'notifications',
      apiClientId: null,
      idempotencyKey: `dash:${randomUUID()}`,
      createdBy: actor.userId,
      deliveryMode: 'text',
    },
    opts.provider ? { provider: opts.provider } : {},
  );
  if (!res.ok) return res;
  return ok({
    messageId: res.value.row.id,
    status: res.value.row.status,
    errorCode: res.value.row.error_code,
  });
}

export async function dashboardResend(
  db: Db,
  actor: DashboardActor,
  messageId: string,
): Promise<Result<{ messageId: string; jobId: string }>> {
  const m = await getMessageRow(db, messageId);
  if (!m.ok) return m;
  if (!m.value || m.value.direction !== 'out') {
    return err(gatewayError('not_found', 'message_not_found'));
  }
  if (m.value.status !== 'failed' && m.value.status !== 'cancelled') {
    return err(gatewayError('conflict', `not_resendable_${m.value.status}`));
  }
  const kind = m.value.kind === 'media' || m.value.kind === 'template' ? m.value.kind : 'text';
  const gate = await checkSend(db, {
    entryPoint: 'dashboard.resend',
    accountId: m.value.account_id,
    chat: chatOf(m.value),
    kind,
    useCase: (m.value.use_case ?? undefined) as UseCase | undefined,
    actor: { type: 'user', userId: actor.userId },
  });
  if (!gate.ok) return gate;
  if (gate.value.account.org_id !== actor.orgId) {
    return err(gatewayError('forbidden_account', 'other_org'));
  }
  const job = await rpc<string>(db, 'message_requeue', { p_message_id: m.value.id });
  if (!job.ok) return job;
  return ok({ messageId: m.value.id, jobId: job.value });
}
