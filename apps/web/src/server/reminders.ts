import 'server-only';
import { z } from 'zod';
import { err, gatewayError, ok, type GatewayError, type Result } from '@htz/core';
import type { CloudApiProvider } from '@htz/provider-cloud';
import type { Db } from './supabase';
import { query, rpc } from './db';
import { readCloudCredentials } from './cloud';
import { json } from './http';
import { logError, logInfo } from './log';
import { enqueueAndDispatch } from './outbound';
import { checkSend, type GateOk } from './send-gate';
import { getAccount } from './repo/accounts';
import { REMINDER_KEY_PREFIX } from './internal';

/**
 * Reminder dispatch (TEST-PLAN R4.1-R4.6, S13). Called per claimed reminder by the
 * `reminders-dispatch` Edge Function (pg_cron `gw-reminders`, every minute) through
 * POST /api/internal/reminders. Every reminder send passes THE send gate with entry point
 * `reminders.dispatch`: text inside the 24h window, an approved template outside it, otherwise
 * `outside_24h_window` (R4.2). Then `enqueue_message` (idempotency key `reminder:<id>`):
 * Cloud → direct Graph send + `message_record_send_result`; Baileys → worker queue (gated again).
 */

export const reminderDispatchBody = z.object({
  reminder_id: z.uuid(),
  lease_until: z.string().min(1).optional(),
});

interface ReminderRow {
  id: string;
  account_id: string;
  to_e164: string;
  body: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: unknown;
  state: string;
  message_id: string | null;
  lease_until: string | null;
  api_client_id: string | null;
}

const REMINDER_DISPATCH_COLUMNS =
  'id, account_id, to_e164, body, template_name, template_language, template_params, state, message_id, lease_until, api_client_id';

type Candidate = { kind: 'text'; text: string } | { kind: 'template'; template: TemplateRef };
interface TemplateRef {
  name: string;
  language: string;
  params: string[];
}

function candidatesOf(r: ReminderRow): Candidate[] {
  const out: Candidate[] = [];
  if (r.body) out.push({ kind: 'text', text: r.body });
  if (r.template_name && r.template_language) {
    const params = Array.isArray(r.template_params)
      ? r.template_params.filter((p): p is string => typeof p === 'string')
      : [];
    out.push({
      kind: 'template',
      template: { name: r.template_name, language: r.template_language, params },
    });
  }
  return out;
}

/** Text first; outside the 24h window fall back to the template (R4.1-R4.3). */
async function gateReminder(
  db: Db,
  r: ReminderRow,
  now: Date,
): Promise<Result<{ decision: GateOk; candidate: Candidate }>> {
  const candidates = candidatesOf(r);
  let last: GatewayError = gatewayError('invalid_input', 'reminder_empty', { transient: false });
  for (const c of candidates) {
    const g = await checkSend(
      db,
      {
        entryPoint: 'reminders.dispatch',
        accountId: r.account_id,
        chat: r.to_e164,
        kind: c.kind,
        useCase: 'reminders',
        actor: { type: 'system', component: 'reminders.dispatch' },
      },
      now,
    );
    if (g.ok) return ok({ decision: g.value, candidate: c });
    last = g.error;
    if (g.error.code !== 'outside_24h_window') break;
  }
  return err(last);
}

async function existingReminderMessage(db: Db, r: ReminderRow): Promise<Result<string | null>> {
  const m = await query<{ id: string } | null>(
    db
      .from('messages')
      .select('id')
      .eq('account_id', r.account_id)
      .eq('idempotency_key', `${REMINDER_KEY_PREFIX}${r.id}`)
      .limit(1)
      .maybeSingle(),
    'messages.by_reminder',
  );
  return m.ok ? ok(m.value?.id ?? null) : m;
}

export async function handleReminderDispatch(
  body: unknown,
  db: Db,
  opts: { provider?: CloudApiProvider; now?: () => Date } = {},
): Promise<Response> {
  const p = reminderDispatchBody.safeParse(body);
  if (!p.success) return json(400, { ok: false, code: 'invalid_input' });
  const now = (opts.now ?? (() => new Date()))();

  const row = await query<ReminderRow | null>(
    db
      .from('reminders')
      .select(REMINDER_DISPATCH_COLUMNS)
      .eq('id', p.data.reminder_id)
      .maybeSingle(),
    'reminders.get',
  );
  if (!row.ok) return json(503, { ok: false, code: 'internal' });
  const r = row.value;
  if (!r) return json(404, { ok: false, code: 'not_found' });
  if (
    r.state !== 'sending' ||
    r.message_id !== null ||
    !r.lease_until ||
    Date.parse(r.lease_until) <= now.getTime()
  ) {
    return json(409, { ok: false, code: 'lease_lost' }); // cancelled, done, or someone else owns it
  }

  const record = async (args: Record<string, unknown>) => {
    const rec = await rpc<string>(db, 'reminder_record_dispatch', {
      p_reminder_id: r.id,
      ...args,
    });
    if (!rec.ok) {
      logError('reminder_record_failed', { code: rec.error.code });
      return json(503, { ok: false, code: 'internal' });
    }
    return json(200, { ok: true, outcome: rec.value });
  };

  // Crash between enqueue and record: the message already exists → just link it (no resend).
  const prior = await existingReminderMessage(db, r);
  if (!prior.ok) return json(503, { ok: false, code: 'internal' });
  if (prior.value) return record({ p_message_id: prior.value });

  const acc = await getAccount(db, r.account_id);
  if (!acc.ok) return json(503, { ok: false, code: 'internal' });
  if (!acc.value) return record({ p_error_code: 'not_found', p_detail: 'account_not_found' });
  const account = acc.value;

  // R4.4: Cloud account without credentials → unconfigured, no attempt used, retried each minute.
  if (account.provider === 'meta_cloud') {
    const c = await readCloudCredentials(db, account.id);
    if (!c.ok) return json(503, { ok: false, code: 'internal' });
    if (!c.value?.accessToken || !c.value.phoneNumberId) return record({ p_unconfigured: true });
  }

  const gate = await gateReminder(db, r, now);
  if (!gate.ok) {
    if (gate.error.code === 'internal') return json(503, { ok: false, code: 'internal' }); // fail closed, retried
    logInfo('reminder_gate_rejected', { code: gate.error.code });
    return record({ p_error_code: gate.error.code, p_detail: gate.error.detail ?? null });
  }
  const { decision, candidate } = gate.value;

  const res = await enqueueAndDispatch(
    db,
    {
      accountId: account.id,
      provider: account.provider,
      chat: decision.chat.jid,
      kind: candidate.kind,
      text: candidate.kind === 'text' ? candidate.text : null,
      template: candidate.kind === 'template' ? candidate.template : null,
      useCase: 'reminders',
      apiClientId: r.api_client_id,
      idempotencyKey: `${REMINDER_KEY_PREFIX}${r.id}`,
      createdBy: null,
      deliveryMode: candidate.kind === 'text' ? 'text' : 'native',
      requestedAt: now.toISOString(),
    },
    opts.provider ? { provider: opts.provider } : {},
  );
  if (!res.ok) return json(503, { ok: false, code: 'internal' }); // lease expires → re-claimed
  return record({ p_message_id: res.value.row.id });
}
