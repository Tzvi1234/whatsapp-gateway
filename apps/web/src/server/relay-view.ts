import { formatE164ForDisplay, type LiaTestResult } from '@htz/core';
import { channelVerification } from '@htz/relay';

/** Masks a webhook URL to scheme + host + last 4 chars of the rest (ARCH §4.7). */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`;
    return `${u.protocol}//${u.host}/…${rest.length > 4 ? rest.slice(-4) : ''}`;
  } catch {
    return '…';
  }
}

export interface RelayTargetView {
  id: string;
  accountId: string;
  name: string;
  urlMasked: string;
  secretLast4: string | null;
  enabled: boolean;
  debounceMs: number;
  noReplyThresholdMin: number;
  allowlist: { e164: string; display: string }[];
  channel: 'untested' | 'verified';
  lastVerifiedAt: string | null;
  lastTest: LiaTestResult | null;
  /** L5.7: Cloud API chosen for Lia → show the Meta-policy warning (not blocked). */
  metaPolicyWarning: boolean;
}

export interface TargetRow {
  id: string;
  org_id: string;
  account_id: string;
  name: string;
  url: string;
  secret_last4: string | null;
  enabled: boolean;
  debounce_ms: number;
  no_reply_threshold_min: number;
  allowed_senders: string[];
  last_verified_at: string | null;
  last_test: LiaTestResult | null;
}
export const TARGET_COLUMNS =
  'id, org_id, account_id, name, url, secret_last4, enabled, debounce_ms, no_reply_threshold_min, allowed_senders, last_verified_at, last_test';

export function toTargetView(row: TargetRow, provider: string): RelayTargetView {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    urlMasked: maskUrl(row.url),
    secretLast4: row.secret_last4,
    enabled: row.enabled,
    debounceMs: row.debounce_ms,
    noReplyThresholdMin: row.no_reply_threshold_min,
    allowlist: row.allowed_senders.map((e) => ({ e164: e, display: formatE164ForDisplay(e) })),
    channel: channelVerification({
      last_verified_at: row.last_verified_at,
      last_test: row.last_test,
    }),
    lastVerifiedAt: row.last_verified_at,
    lastTest: row.last_test,
    metaPolicyWarning: provider === 'meta_cloud',
  };
}
