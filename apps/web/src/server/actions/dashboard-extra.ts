'use server';

import { z } from 'zod';
import { formatE164ForDisplay } from '@htz/core';
import { requireMemberAal2, requireOwnerAal2 } from '../auth';
import { userClient } from '../supabase';
import { query } from '../db';
import { fail, fromGatewayError, GENERIC_HE, okResult, type ActionResult } from './result';

/**
 * Two small read models the dashboard needs that the catalogue did not cover (added by the
 * UI agent, read-only, user client so RLS + AAL2 apply):
 *  - allowlist audit trail for the Lia setup screen (L6.1: who, when, before, after);
 *  - outbound queue depth per account (home issues, Health page, ARCH §8.4).
 */

export interface AllowlistAuditEntry {
  id: string;
  at: string;
  actorType: string;
  /** true when the actor is the viewing user ("אתה"). */
  actorIsViewer: boolean;
  before: { e164: string; display: string }[];
  after: { e164: string; display: string }[];
}

const asList = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((e) => ({ e164: e, display: formatE164ForDisplay(e) }))
    : [];

export async function getAllowlistAudit(
  relayTargetId: string,
): Promise<ActionResult<AllowlistAuditEntry[]>> {
  const auth = await requireOwnerAal2();
  if (!auth.ok) return auth;
  if (!z.uuid().safeParse(relayTargetId).success) return fail('not_found', GENERIC_HE.not_found);
  const sb = await userClient();
  const r = await query<
    { id: string; at: string; actor_type: string; actor_id: string | null; meta: unknown }[]
  >(
    sb
      .from('audit_log')
      .select('id, at, actor_type, actor_id, meta')
      .eq('action', 'relay_allowlist.update')
      .eq('target', `relay_target:${relayTargetId}`)
      .order('at', { ascending: false })
      .limit(20),
    'audit.allowlist',
  );
  if (!r.ok) return fromGatewayError(r.error);
  return okResult(
    (r.value ?? []).map((row) => {
      const meta = (row.meta ?? {}) as { before?: unknown; after?: unknown };
      return {
        id: row.id,
        at: row.at,
        actorType: row.actor_type,
        actorIsViewer: row.actor_id === auth.data.userId,
        before: asList(meta.before),
        after: asList(meta.after),
      };
    }),
  );
}

export interface QueueStats {
  /** Pending (ready + leased) jobs per account. */
  byAccount: Record<string, number>;
  total: number;
  oldestRunAt: string | null;
}

export async function getQueueStats(): Promise<ActionResult<QueueStats>> {
  const auth = await requireMemberAal2();
  if (!auth.ok) return auth;
  const sb = await userClient();
  const r = await query<{ account_id: string; run_at: string }[]>(
    sb
      .from('outbound_queue')
      .select('account_id, run_at')
      .in('state', ['ready', 'leased'])
      .order('run_at', { ascending: true })
      .limit(1000),
    'queue.stats',
  );
  if (!r.ok) return fromGatewayError(r.error);
  const rows = r.value ?? [];
  const byAccount: Record<string, number> = {};
  for (const x of rows) byAccount[x.account_id] = (byAccount[x.account_id] ?? 0) + 1;
  return okResult({ byAccount, total: rows.length, oldestRunAt: rows[0]?.run_at ?? null });
}
