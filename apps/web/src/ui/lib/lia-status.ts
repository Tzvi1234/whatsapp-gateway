import {
  LIA_DEFAULT_NO_REPLY_MIN,
  LIA_TEST_STATUSES,
  LIA_WAITING_WINDOW_MS,
  type LiaTestResult,
  type LiaTestStatus,
} from '@htz/core';
import { he } from '../i18n/he';
import { formatDuration } from './time';

/**
 * Lia channel status → Hebrew copy + tone (contracts/lia-connection-test.md, L4.x, L5.x).
 * Rules: `accepted` is never a failure (first 2 min "waiting", then still waiting until the
 * no-reply threshold); "untested" is a channel state (last_verified_at null), not a test
 * status; raw codes appear only in `codes` (rendered under "מה לבדוק", L5.8).
 */

export type Tone = 'ok' | 'wait' | 'warn' | 'bad';
export type PillTone = 'neutral' | 'ok' | 'warn' | 'bad';
export type LiaAction =
  'save_wait' | 'finish' | 'resend' | 'save_anyway' | 'rescan' | 'replace_key' | 'retry';

export interface LiaResultView {
  key: LiaTestStatus | 'none' | 'sending' | 'retrying';
  tone: Tone;
  icon: 'check' | 'info' | 'alert' | 'refresh';
  title: string;
  body: string | null;
  timeline: { label: string; value: string }[];
  actions: { kind: LiaAction; label: string; primary: boolean }[];
  /** Plain-language hint for "מה לבדוק" (may mention tool/field names). */
  check: string | null;
  /** Stable English codes, only for the collapsible "מה לבדוק". */
  codes: string[];
  /** Small "send the same batch again" note under the actions. */
  sub: string | null;
}

export interface PillView {
  tone: PillTone;
  label: string;
}

const R = he.liaResult;

export function isLiaTestStatus(v: unknown): v is LiaTestStatus {
  return typeof v === 'string' && (LIA_TEST_STATUSES as readonly string[]).includes(v);
}

function codesOf(t: LiaTestResult): string[] {
  const out: string[] = [t.status];
  if (t.reason && t.reason !== t.status) out.push(t.reason);
  return out;
}

export function liaResultView(
  test: LiaTestResult | null,
  opts: { thresholdMin?: number; phase?: 'sending' | 'retrying' | null } = {},
): LiaResultView {
  const thresholdMin = opts.thresholdMin ?? LIA_DEFAULT_NO_REPLY_MIN;
  const base = { timeline: [], actions: [], check: null, codes: [], sub: null, body: null };
  if (opts.phase === 'sending') {
    return {
      ...base,
      key: 'sending',
      tone: 'wait',
      icon: 'refresh',
      title: he.lia.sendingTitle,
      body: he.lia.sendingBody,
    };
  }
  if (opts.phase === 'retrying') {
    return {
      ...base,
      key: 'retrying',
      tone: 'wait',
      icon: 'refresh',
      title: R.retrying.title,
      body: R.retrying.body,
    };
  }
  if (!test || !isLiaTestStatus(test.status)) {
    return {
      ...base,
      key: 'none',
      tone: 'wait',
      icon: 'info',
      title: he.lia.noTestYet,
      body: he.lia.noTestYetBody,
    };
  }
  const codes = codesOf(test);
  switch (test.status) {
    case 'accepted':
      return {
        ...base,
        key: 'accepted',
        tone: 'wait',
        icon: 'info',
        title: R.accepted.title,
        body: R.accepted.body(thresholdMin),
        actions: [{ kind: 'save_wait', label: R.accepted.action, primary: true }],
        check: R.accepted.check,
        codes,
      };
    case 'replied': {
      const timeline: { label: string; value: string }[] = [];
      if (test.received_ms !== undefined)
        timeline.push({ label: R.replied.received, value: formatDuration(test.received_ms) });
      if (test.reply_ms !== undefined)
        timeline.push({ label: R.replied.replied, value: formatDuration(test.reply_ms) });
      return {
        ...base,
        key: 'replied',
        tone: 'ok',
        icon: 'check',
        title: R.replied.title,
        timeline,
        actions: [{ kind: 'finish', label: R.replied.action, primary: true }],
        check: R.replied.check,
        codes,
      };
    }
    case 'no_reply':
      return {
        ...base,
        key: 'no_reply',
        tone: 'warn',
        icon: 'info',
        title: R.no_reply.title,
        body: R.no_reply.body(thresholdMin),
        actions: [
          { kind: 'resend', label: R.no_reply.resend, primary: false },
          { kind: 'save_anyway', label: R.no_reply.saveAnyway, primary: false },
        ],
        check: R.no_reply.check,
        codes,
        sub: he.lia.resendSub,
      };
    case 'delivery_failed':
      return {
        ...base,
        key: 'delivery_failed',
        tone: 'bad',
        icon: 'alert',
        title: R.delivery_failed.title,
        body: R.delivery_failed.body,
        actions: [{ kind: 'rescan', label: R.delivery_failed.action, primary: true }],
        check: R.delivery_failed.check,
        codes,
      };
    case 'rejected_key':
      return {
        ...base,
        key: 'rejected_key',
        tone: 'bad',
        icon: 'alert',
        title: R.rejected_key.title,
        body: R.rejected_key.body,
        actions: [{ kind: 'replace_key', label: R.rejected_key.action, primary: false }],
        check: R.rejected_key.check,
        codes,
      };
    case 'unreachable':
      return {
        ...base,
        key: 'unreachable',
        tone: 'bad',
        icon: 'alert',
        title: R.unreachable.title,
        body: R.unreachable.body,
        actions: [{ kind: 'retry', label: R.unreachable.action, primary: false }],
        check: R.unreachable.check,
        codes,
      };
  }
}

/** True while an `accepted` test is inside the first 2 minutes (UI "waiting" phase). */
export function inWaitingWindow(test: LiaTestResult | null): boolean {
  if (!test || test.status !== 'accepted') return false;
  return test.waiting === true || test.elapsed_ms < LIA_WAITING_WINDOW_MS;
}

/**
 * Header pill for the channel (status card, home mini card). Words only (Reviewer fix: no
 * technical tags in status-card headers). Untested wins until a test reaches `replied`
 * (L5.2/L5.3); afterwards the latest real delivery decides.
 */
export function liaPill(input: {
  exists: boolean;
  enabled: boolean;
  channel: 'untested' | 'verified';
  latestStatus: LiaTestStatus | null;
}): PillView {
  const P = he.liaPill;
  if (!input.exists || input.channel === 'untested') return { tone: 'neutral', label: P.untested };
  if (!input.enabled) return { tone: 'neutral', label: P.off };
  switch (input.latestStatus) {
    case 'no_reply':
      return { tone: 'warn', label: P.no_reply };
    case 'delivery_failed':
      return { tone: 'bad', label: P.delivery_failed };
    case 'rejected_key':
      return { tone: 'bad', label: P.rejected_key };
    case 'unreachable':
      return { tone: 'bad', label: P.unreachable };
    case 'accepted':
      return { tone: 'neutral', label: P.waiting };
    default:
      return { tone: 'ok', label: P.verified };
  }
}

/** CSS class for `.pill` (neutral = no modifier, as in the mockup's "לא נבדק"). */
export const pillClass = (t: PillTone) =>
  t === 'ok' ? 'pill ok' : t === 'warn' ? 'pill warn' : t === 'bad' ? 'pill bad' : 'pill';

/** CSS class for `.res` cards. */
export const resClass = (t: Tone) => `res ${t}`;
