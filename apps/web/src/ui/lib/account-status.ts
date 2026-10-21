import type { AccountCard, AlertView } from '@/server/actions/read-models';
import { he, joinHe } from '../i18n/he';
import { minutesBetween } from './time';

/** Account / home-page status logic (direction C: issues first, one fix each). Pure. */

export type Dot = 'ok' | 'warn' | 'crit' | 'idle';

export interface StatusView {
  dot: Dot;
  label: string;
  /** ISO time the bad state started (for "מנותק מ-HH:MM"), if known. */
  since: string | null;
  bad: boolean;
}

const DOWN = new Set(['closed', 'needs_relink', 'conflict']);

export function accountStatusView(a: AccountCard): StatusView {
  const s = a.status;
  const C = he.conn;
  switch (s) {
    case 'open':
      return { dot: 'ok', label: C.open, since: null, bad: false };
    case 'connecting':
      return { dot: 'warn', label: C.connecting, since: null, bad: false };
    case 'closed':
      return { dot: 'crit', label: C.closed, since: a.lastHeartbeatAt, bad: true };
    case 'needs_relink':
      return { dot: 'crit', label: C.needs_relink, since: a.lastHeartbeatAt, bad: true };
    case 'conflict':
      return { dot: 'crit', label: C.conflict, since: a.lastHeartbeatAt, bad: true };
    case 'paused':
      return { dot: 'warn', label: C.paused, since: null, bad: true };
    case 'unconfigured':
      return { dot: 'idle', label: C.unconfigured, since: null, bad: false };
    default:
      return { dot: 'idle', label: C.unknown, since: null, bad: false };
  }
}

export const dotColor = (d: Dot) =>
  d === 'ok'
    ? 'var(--ok)'
    : d === 'warn'
      ? 'var(--warn)'
      : d === 'crit'
        ? 'var(--crit)'
        : 'var(--line)';

export const providerLabel = (p: string) =>
  p === 'meta_cloud' ? he.provider.meta_cloud : he.provider.baileys;
export const providerClass = (p: string) => (p === 'meta_cloud' ? 'prov cloud' : 'prov');

/** "שירות לקוחות ותזכורות" from allowed use cases (ARCH §7.6). */
export function useCasesText(a: Pick<AccountCard, 'relay' | 'allowedUseCases' | 'isTest'>): string {
  if (a.relay) return he.useCase.relayPersonal;
  const labels = a.allowedUseCases
    .map((u) => (he.useCase as Record<string, unknown>)[u])
    .filter((x): x is string => typeof x === 'string');
  const text = labels.length ? joinHe(labels) : he.useCase.none;
  return a.isTest ? `${text} · ${he.useCase.testNumber}` : text;
}

/* ------------------------------------------------------------------ issues */

export type IssueAction =
  | {
      kind: 'link';
      label: string;
      href: string;
      icon: 'refresh' | 'send' | 'key' | 'link' | 'pulse';
    }
  | { kind: 'reconnect'; label: string; accountId: string }
  | { kind: 'resend_lia'; label: string; batchId: string };

export interface Issue {
  id: string;
  crit: boolean;
  say: { pre: string; em: string; post: string };
  why: string;
  action: IssueAction;
  account: AccountCard | null;
  /** Stable code for "מה לבדוק". */
  code: string;
  at: string | null;
}

export interface IssueInput {
  accounts: AccountCard[];
  alerts: AlertView[];
  /** Queued outbound per account (optional). */
  queued?: Record<string, number>;
  /** Latest no-reply Lia batch per relay account, for one-click resend (owner only). */
  liaNoReplyBatch?: Record<string, string>;
  isOwner: boolean;
  now?: number;
}

const IS_DOWN_ALERT = new Set(['needs_relink', 'conflict']);

export function deriveIssues(input: IssueInput): Issue[] {
  const I = he.issue;
  const now = input.now ?? Date.now();
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const out: Issue[] = [];
  const alertFor = (accountId: string, kinds: string[]) =>
    input.alerts.find((x) => x.accountId === accountId && kinds.includes(x.kind));
  const numberHref = (id: string) => `/numbers/${id}`;
  const ownerOr = (a: AccountCard, act: IssueAction): IssueAction =>
    input.isOwner
      ? act
      : { kind: 'link', label: he.home.whatHappened, href: numberHref(a.id), icon: 'link' };

  for (const a of input.accounts) {
    const q = input.queued?.[a.id] ?? 0;
    const waiting = q > 0 ? I.waiting(q) : '.';
    const rescan: IssueAction = {
      kind: 'link',
      label: I.actRescan,
      href: `/connect?account=${a.id}&method=qr`,
      icon: 'refresh',
    };
    const fixCreds: IssueAction = {
      kind: 'link',
      label: I.actFixCreds,
      href: `/connect?account=${a.id}&method=cloud`,
      icon: 'key',
    };
    const reconnect: IssueAction = { kind: 'reconnect', label: I.actReconnect, accountId: a.id };

    if (a.status === 'needs_relink') {
      const al = alertFor(a.id, ['needs_relink']);
      const since = al?.openedAt ?? a.lastHeartbeatAt;
      const s = since
        ? I.needsRelinkSince(a.label, I.sinceMinutes(minutesBetween(since, now)))
        : I.needsRelinkSay(a.label);
      out.push({
        id: `acc:${a.id}`,
        crit: true,
        say: { ...s, post: waiting },
        why: I.needsRelinkWhy,
        action: ownerOr(a, a.provider === 'baileys' ? rescan : fixCreds),
        account: a,
        code: 'needs_relink',
        at: since,
      });
    } else if (a.status === 'conflict') {
      out.push({
        id: `acc:${a.id}`,
        crit: true,
        say: I.conflictSay(a.label),
        why: I.conflictWhy,
        action: ownerOr(a, reconnect),
        account: a,
        code: 'conflict',
        at: alertFor(a.id, ['conflict'])?.openedAt ?? a.lastHeartbeatAt,
      });
    } else if (a.status === 'closed') {
      const cloudCreds =
        a.provider === 'meta_cloud' &&
        (a.lastErrorCode === 'invalid_credentials' || a.lastErrorCode === 'provider_unconfigured');
      out.push({
        id: `acc:${a.id}`,
        crit: !cloudCreds,
        say: cloudCreds
          ? I.cloudCredsSay(a.label)
          : { ...I.closedSay(a.label), post: q > 0 ? waiting : '.' },
        why: cloudCreds ? I.cloudCredsWhy : I.closedWhy,
        action: ownerOr(a, cloudCreds ? fixCreds : a.provider === 'baileys' ? reconnect : fixCreds),
        account: a,
        code: a.lastErrorCode ?? 'closed',
        at: a.lastHeartbeatAt,
      });
    } else if (a.status === 'paused') {
      out.push({
        id: `acc:${a.id}`,
        crit: false,
        say: I.pausedSay(a.label),
        why: I.pausedWhy,
        action: ownerOr(a, reconnect),
        account: a,
        code: 'paused',
        at: null,
      });
    } else if (a.status === 'unconfigured') {
      const cloud = a.provider === 'meta_cloud';
      out.push({
        id: `acc:${a.id}`,
        crit: false,
        say: cloud ? I.cloudUnconfiguredSay(a.label) : I.unconfiguredBaileysSay(a.label),
        why: cloud ? I.cloudCredsWhy : I.unconfiguredBaileysWhy,
        action: ownerOr(a, cloud ? fixCreds : { ...rescan, label: I.actConnect }),
        account: a,
        code: 'unconfigured',
        at: null,
      });
    }
  }

  // Alerts not already explained by an account state.
  const dead = new Map<string, AlertView[]>();
  const seen = new Set<string>();
  for (const al of input.alerts) {
    const a = al.accountId ? (byId.get(al.accountId) ?? null) : null;
    if (IS_DOWN_ALERT.has(al.kind) && a && DOWN.has(a.status)) continue;
    if (al.kind === 'dead_letter' && a) {
      dead.set(a.id, [...(dead.get(a.id) ?? []), al]);
      continue;
    }
    const key = `${al.kind}:${al.accountId ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const liaHref = a ? `/numbers/${a.id}/lia` : '/';
    if (al.kind === 'relay_no_reply' && a) {
      const batch = input.liaNoReplyBatch?.[a.id];
      out.push({
        id: `al:${al.id}`,
        crit: false,
        say: I.liaNoReplySay,
        why: I.liaNoReplyWhy,
        action:
          batch && input.isOwner
            ? { kind: 'resend_lia', label: I.actResendLia, batchId: batch }
            : ownerOr(a, { kind: 'link', label: I.actCheckLia, href: liaHref, icon: 'send' }),
        account: a,
        code: al.kind,
        at: al.openedAt,
      });
    } else if (al.kind === 'relay_rejected_key' && a) {
      out.push({
        id: `al:${al.id}`,
        crit: true,
        say: I.liaKeySay,
        why: I.liaKeyWhy,
        action: ownerOr(a, { kind: 'link', label: I.actFixKey, href: liaHref, icon: 'key' }),
        account: a,
        code: al.kind,
        at: al.openedAt,
      });
    } else if (al.kind === 'relay_unreachable' && a) {
      out.push({
        id: `al:${al.id}`,
        crit: true,
        say: I.liaUnreachableSay,
        why: I.liaUnreachableWhy,
        action: ownerOr(a, { kind: 'link', label: I.actCheckLia, href: liaHref, icon: 'send' }),
        account: a,
        code: al.kind,
        at: al.openedAt,
      });
    } else if (al.kind === 'worker_down') {
      out.push({
        id: `al:${al.id}`,
        crit: true,
        say: I.workerDownSay,
        why: I.workerDownWhy,
        action: { kind: 'link', label: I.actHealth, href: '/health', icon: 'pulse' },
        account: null,
        code: al.kind,
        at: al.openedAt,
      });
    } else if (al.kind === 'webhook_failing') {
      out.push({
        id: `al:${al.id}`,
        crit: false,
        say: I.webhookSay,
        why: I.webhookWhy,
        action: { kind: 'link', label: I.actHealth, href: '/health', icon: 'pulse' },
        account: null,
        code: al.kind,
        at: al.openedAt,
      });
    } else if (!IS_DOWN_ALERT.has(al.kind)) {
      out.push({
        id: `al:${al.id}`,
        crit: al.severity === 'P1',
        say: I.otherSay,
        why: I.otherWhy,
        action: a
          ? { kind: 'link', label: he.home.whatHappened, href: `/numbers/${a.id}`, icon: 'link' }
          : { kind: 'link', label: I.actHealth, href: '/health', icon: 'pulse' },
        account: a,
        code: al.kind,
        at: al.openedAt,
      });
    }
  }
  for (const [accountId, list] of dead) {
    const a = byId.get(accountId)!;
    out.push({
      id: `dead:${accountId}`,
      crit: false,
      say: I.deadLetterSay(a.label, list.length),
      why: I.deadLetterWhy,
      action: {
        kind: 'link',
        label: I.actResend,
        href: `/numbers/${accountId}#failed`,
        icon: 'send',
      },
      account: a,
      code: 'dead_letter',
      at: list[0]?.openedAt ?? null,
    });
  }

  return out.sort((x, y) => {
    if (x.crit !== y.crit) return x.crit ? -1 : 1;
    return (y.at ?? '').localeCompare(x.at ?? '');
  });
}

/** H1 of the home page ("שני דברים צריכים אותך" / "הכול עובד"). */
export function homeHeadline(issueCount: number): string {
  if (issueCount <= 0) return he.home.allOk;
  if (issueCount === 1) return he.home.one;
  if (issueCount === 2) return he.home.two;
  return he.home.many(issueCount);
}
