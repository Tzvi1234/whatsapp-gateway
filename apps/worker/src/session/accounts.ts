/**
 * Per-account facts the send gate and the inbound router need (policy, capabilities, relay
 * target + allowlist), cached for a short TTL so a burst of messages does not hit the DB each time.
 */
import { BAILEYS_CAPABILITIES, type Capabilities } from '@htz/core';
import { normalizeAllowlist } from '@htz/policy';
import type { AccountRow, RelayTargetRow, WorkerDb } from '../db/types';

export interface AccountContext {
  account: AccountRow;
  capabilities: Capabilities;
  /** Raw policy handed to `assertChatAllowed` (relay accounts: allowlist merged, relay forced on). */
  gatePolicy: unknown;
  /** Enabled relay target (Lia channel), else null. */
  relayTarget: RelayTargetRow | null;
  /** E.164 allowlist = relay_targets.allowed_senders ∪ LIA_ALLOWLIST_SEED. Empty for non-relay. */
  relayAllowlist: string[];
  isRelay: boolean;
  statusAutomation: boolean;
}

const CAP_KEYS = Object.keys(BAILEYS_CAPABILITIES) as (keyof Capabilities)[];
const SUPPORT = new Set(['supported', 'unsupported', 'unverified']);

/** Persisted capabilities over the Baileys defaults; wrongly typed values are ignored. */
export function resolveCapabilities(raw: Record<string, unknown> | null | undefined): Capabilities {
  const out: Record<string, unknown> = { ...BAILEYS_CAPABILITIES };
  for (const k of CAP_KEYS) {
    const v = raw?.[k];
    const d = BAILEYS_CAPABILITIES[k];
    if (v === undefined || k === 'text') continue;
    if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (k === 'groups' && (v === 'full' || v === 'none')) out[k] = v;
    else if ((k === 'nativeButtons' || k === 'lists') && typeof v === 'string' && SUPPORT.has(v))
      out[k] = v;
  }
  return out as unknown as Capabilities;
}

export function buildAccountContext(
  account: AccountRow,
  targets: readonly RelayTargetRow[],
  seed: readonly string[],
): AccountContext {
  const policy = (account.use_case_policy ?? {}) as Record<string, unknown>;
  const relayTarget = targets.find((t) => t.enabled) ?? null;
  const isRelay = relayTarget !== null || policy.relay === true;
  const relayAllowlist = isRelay
    ? [...normalizeAllowlist([...(relayTarget?.allowed_senders ?? []), ...seed])]
    : [];
  let gatePolicy: unknown = policy;
  if (isRelay) {
    const existing = policy.sender_allowlist;
    gatePolicy = {
      ...policy,
      relay: true,
      // Keep a malformed value as is: the gate then fails closed.
      sender_allowlist: Array.isArray(existing)
        ? [...new Set([...(existing as string[]), ...relayAllowlist])]
        : existing === undefined
          ? relayAllowlist
          : existing,
    };
  }
  const useCases = Array.isArray(policy.allowed_use_cases) ? policy.allowed_use_cases : [];
  return {
    account,
    capabilities: resolveCapabilities(account.capabilities),
    gatePolicy,
    relayTarget,
    relayAllowlist,
    isRelay,
    statusAutomation: useCases.includes('status_automation'),
  };
}

export interface AccountDirectory {
  get(accountId: string): Promise<AccountContext | null>;
  invalidate(accountId?: string): void;
}

export function createAccountDirectory(
  db: Pick<WorkerDb, 'getAccount' | 'listRelayTargets'>,
  opts: { seed: readonly string[]; ttlMs?: number; now?: () => number },
): AccountDirectory {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { ctx: AccountContext | null; exp: number }>();
  return {
    async get(accountId) {
      const hit = cache.get(accountId);
      if (hit && hit.exp > now()) return hit.ctx;
      const account = await db.getAccount(accountId);
      const ctx = account
        ? buildAccountContext(account, await db.listRelayTargets(accountId), opts.seed)
        : null;
      cache.set(accountId, { ctx, exp: now() + ttl });
      return ctx;
    },
    invalidate(accountId) {
      if (accountId) cache.delete(accountId);
      else cache.clear();
    },
  };
}
