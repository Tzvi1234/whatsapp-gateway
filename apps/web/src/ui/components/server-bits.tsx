import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AccountCard } from '@/server/actions/read-models';
import type { ActionFail } from '@/server/actions/result';
import { he } from '../i18n/he';
import {
  accountStatusView,
  dotColor,
  providerClass,
  providerLabel,
  useCasesText,
  type Issue,
} from '../lib/account-status';
import { formatTime } from '../lib/time';
import { Icon, Num } from './Icon';
import { ReconnectButton, ResendLiaButton, WhatToCheck } from './client';

/** Server-rendered building blocks shared by several pages. */

export function ProviderBadge({ provider }: { provider: string }) {
  return <span className={providerClass(provider)}>{providerLabel(provider)}</span>;
}

export function Crumbs({ children }: { children: ReactNode }) {
  return (
    <nav className="crumbs" aria-label="פירורי לחם">
      <Link href="/">{he.app.home}</Link> · {children}
    </nav>
  );
}

export function ConnPill({
  account,
  since,
}: {
  account: AccountCard;
  since?: string | null | undefined;
}) {
  const base = accountStatusView(account);
  const v = since && base.bad ? { ...base, since } : base;
  return (
    <span className={v.bad ? 'conn bad' : 'conn'}>
      <i style={v.dot === 'ok' || v.dot === 'crit' ? undefined : { background: dotColor(v.dot) }} />
      {v.since && v.bad ? (
        <>
          {he.conn.closedSince}
          <Num>{formatTime(v.since)}</Num>
        </>
      ) : (
        v.label
      )}
    </span>
  );
}

export function NumberRow({ a, right }: { a: AccountCard; right: ReactNode }) {
  const v = accountStatusView(a);
  return (
    <Link href={`/numbers/${a.id}`}>
      <i className="dot" style={{ background: dotColor(v.dot) }} aria-hidden="true" />
      <div>
        <strong>{a.label}</strong>
        <small>
          {useCasesText(a)}
          {a.phoneDisplay ? (
            <>
              {' · '}
              <Num>{a.phoneDisplay}</Num>
            </>
          ) : null}
          <span className="sr-only"> · {v.label}</span>
        </small>
      </div>
      <ProviderBadge provider={a.provider} />
      <span className="right">{right}</span>
    </Link>
  );
}

export function IssueCard({ issue }: { issue: Issue }) {
  const act = issue.action;
  return (
    <article className={issue.crit ? 'issue crit' : 'issue'}>
      <div>
        <p className="say">
          {issue.say.pre}
          <em>{issue.say.em}</em>
          {issue.say.post}
        </p>
        <p className="why">{issue.why}</p>
      </div>
      <div className="acts">
        {act.kind === 'link' ? (
          <Link className="btn primary" href={act.href}>
            <Icon name={act.icon} />
            {act.label}
          </Link>
        ) : act.kind === 'reconnect' ? (
          <ReconnectButton accountId={act.accountId} label={act.label} />
        ) : (
          <ResendLiaButton batchId={act.batchId} label={act.label} primary />
        )}
      </div>
      {issue.account ? (
        <div className="meta">
          <ProviderBadge provider={issue.account.provider} />
          {issue.account.phoneDisplay ? (
            <Num>{issue.account.phoneDisplay}</Num>
          ) : (
            <span>{issue.account.label}</span>
          )}
          <Link
            href={`/numbers/${issue.account.id}`}
            style={{ color: 'var(--muted)', marginInlineStart: 'auto' }}
          >
            {he.home.whatHappened}
          </Link>
        </div>
      ) : null}
    </article>
  );
}

/** Plain-language failure block for a page section whose read failed (with one action). */
export function LoadFailed({ error, retryHref }: { error: ActionFail; retryHref?: string }) {
  return (
    <div className="res bad" role="alert" style={{ marginTop: 16 }}>
      <span className="ic">
        <Icon name="alert" style={{ width: 16, height: 16 }} />
      </span>
      <strong>{he.errors.loadFailed}</strong>
      <p>{error.message_he}</p>
      <div className="acts">
        <Link className="btn" href={retryHref ?? '/'}>
          <Icon name="refresh" />
          {he.errors.tryAgain}
        </Link>
      </div>
      <WhatToCheck codes={[error.code]} />
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}
