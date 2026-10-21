import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AccountCard, AccountDetail, FailedMessageView } from '@/server/actions/read-models';
import { he } from '../i18n/he';
import { accountStatusView } from '../lib/account-status';
import { failedTotals, type FailedTotals } from '../lib/metrics';
import { displayFromJid, isGroupJid } from '../lib/phone';
import { buildHourStrip } from '../lib/strip';
import { formatDateTime, formatPct, formatTime } from '../lib/time';
import { CopyButton, ReconnectButton, ResendButton, WhatToCheck } from './client';
import { Icon, Num } from './Icon';

const N = he.number;

/** The one fix action for a number, by provider and state (owner only). */
export function PrimaryAction({ a, relay }: { a: AccountCard; relay: boolean }) {
  const v = accountStatusView(a);
  if (a.provider === 'baileys' && (a.status === 'needs_relink' || a.status === 'unconfigured')) {
    return (
      <Link className="btn primary" href={`/connect?account=${a.id}&method=qr`}>
        <Icon name="refresh" />
        {a.status === 'unconfigured' ? N.connectNow : N.rescan}
      </Link>
    );
  }
  if (a.provider === 'meta_cloud' && (v.bad || a.status === 'unconfigured')) {
    return (
      <Link className="btn primary" href={`/connect?account=${a.id}&method=cloud`}>
        <Icon name="key" />
        {N.fixCreds}
      </Link>
    );
  }
  if (v.bad) return <ReconnectButton accountId={a.id} />;
  if (relay)
    return (
      <Link className="btn" href={`/numbers/${a.id}/lia`}>
        {N.liaSettings}
      </Link>
    );
  return null;
}

export function HourStrip({ detail, now }: { detail: AccountDetail; now: number }) {
  const strip = buildHourStrip(
    detail.sessionEvents,
    detail.failedMessages.map((m) => m.createdAt),
    detail.account.status,
    now,
  );
  const allNone = strip.slots.every((s) => s === 'n');
  const allOk = strip.slots.every((s) => s === 'ok');
  return (
    <section className="card" style={{ marginTop: 22 }} aria-labelledby="h24">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
        <strong id="h24">{N.last24}</strong>
        <span className="uses">{N.hourEach}</span>
      </div>
      <div className="strip" role="img" aria-label={N.stripLabel}>
        {strip.slots.map((s, i) => (
          <span key={i} className={s === 'ok' ? '' : s} />
        ))}
        {strip.onsetPct !== null ? (
          <i className="onset" style={{ left: `${strip.onsetPct}%` }} />
        ) : null}
      </div>
      <div className="axis" aria-hidden="true">
        {strip.ticks.map((t) => (
          <span key={t}>{formatTime(t)}</span>
        ))}
        <span>{N.now}</span>
      </div>
      <p className="uses" style={{ marginTop: 12 }}>
        {allNone ? (
          N.stripNoData
        ) : strip.downSince ? (
          <>
            {N.downSincePre}
            <Num>{formatTime(strip.downSince)}</Num>
            {N.downSincePost}
          </>
        ) : allOk ? (
          N.allGood
        ) : null}
      </p>
    </section>
  );
}

export function ProviderBars({
  rows,
}: {
  rows: { provider: string; window: string; total: number; failed: number; rate: number }[];
}) {
  const b: FailedTotals = failedTotals(rows, '24h', 'baileys');
  const c: FailedTotals = failedTotals(rows, '24h', 'meta_cloud');
  const max = Math.max(b.rate ?? 0, c.rate ?? 0, 0.05);
  const w = (r: number | null) => `${r === null ? 0 : Math.max(2, Math.round((r / max) * 100))}%`;
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <strong>{N.byProvider}</strong>
      <div className="bars">
        <div>
          <span>{he.provider.baileys}</span>
          <i>
            <b style={{ width: w(b.rate) }} />
          </i>
          <span className="num">{formatPct(b.rate)}</span>
        </div>
        <div>
          <span>{he.provider.meta_cloud}</span>
          <i>
            <b style={{ width: w(c.rate), background: 'var(--cloud)' }} />
          </i>
          <span className="num">{formatPct(c.rate)}</span>
        </div>
      </div>
    </section>
  );
}

function chatLabel(jid: string): ReactNode {
  if (!jid) return N.unknownChat;
  if (isGroupJid(jid)) return N.group;
  const d = displayFromJid(jid);
  return d ? <Num>{d}</Num> : N.unknownChat;
}

export function FailedMessages({ items, canAct }: { items: FailedMessageView[]; canAct: boolean }) {
  return (
    <section className="card" style={{ marginTop: 16 }} id="failed" aria-labelledby="fm">
      <strong id="fm">{N.failedTitle}</strong>
      {items.length === 0 ? (
        <p className="uses" style={{ marginTop: 8 }}>
          {N.failedEmpty}
        </p>
      ) : (
        <ul className="rows">
          {items.map((m) => (
            <li key={m.id}>
              <div>
                {chatLabel(m.chat)}
                <small>
                  {he.messageErrors[m.errorCode ?? ''] ?? he.messageErrors.other} ·{' '}
                  <Num>{formatDateTime(m.createdAt)}</Num>
                </small>
              </div>
              <div className="acts">{canAct ? <ResendButton messageId={m.id} /> : null}</div>
              <WhatToCheck codes={[m.errorCode ?? 'unknown', m.kind]} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SessionEvents({ items }: { items: AccountDetail['sessionEvents'] }) {
  return (
    <details className="card audit" style={{ marginTop: 16 }}>
      <summary>{N.eventsTitle}</summary>
      {items.length === 0 ? (
        <p className="uses" style={{ marginTop: 8 }}>
          {N.eventsEmpty}
        </p>
      ) : (
        <ul>
          {items.map((e, i) => (
            <li key={`${e.at}-${i}`} style={{ marginTop: 6 }}>
              <b>{he.events[e.event] ?? he.events.other}</b> · <Num>{formatDateTime(e.at)}</Num>
              <span>
                {he.app.codeLabel}:{' '}
                <code className="num">{[e.event, e.code].filter(Boolean).join(' / ')}</code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function CloudCredsCard({ detail }: { detail: AccountDetail }) {
  const c = detail.credentials;
  const C = he.connect;
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="cc">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <strong id="cc">{N.credsTitle}</strong>
        <Link className="btn sm" href={`/connect?account=${detail.account.id}&method=cloud`}>
          {N.credsEdit}
        </Link>
      </div>
      {c ? (
        <dl className="kv2">
          <dt>{C.phoneNumberId}</dt>
          <dd>
            <Num>{c.phoneNumberId ?? he.app.dash}</Num>
          </dd>
          <dt>{C.wabaId}</dt>
          <dd>
            <Num>{c.wabaId ?? he.app.dash}</Num>
          </dd>
          <dt>{C.accessToken}</dt>
          <dd>
            <Num>{`•••• ${c.tokenLast4 ?? ''}`}</Num>
          </dd>
          <dt>{C.appSecret}</dt>
          <dd>
            <Num>{`•••• ${c.appSecretLast4 ?? ''}`}</Num>
          </dd>
          <dt>{C.verifyToken}</dt>
          <dd>
            <Num>{`•••• ${c.verifyTokenLast4 ?? ''}`}</Num>
          </dd>
          <dt>{N.lastVerified}</dt>
          <dd>
            {c.lastVerifiedAt ? <Num>{formatDateTime(c.lastVerifiedAt)}</Num> : N.notVerified}
          </dd>
        </dl>
      ) : null}
      <div className="field">
        <label>{C.webhookLabel}</label>
        <div className="copyrow">
          <span className="num" style={{ overflowWrap: 'anywhere' }}>
            {detail.webhookUrl}
          </span>
          <CopyButton value={detail.webhookUrl} style={{ height: 32 }} />
        </div>
        <span className="hint">{C.webhookHint}</span>
      </div>
      {detail.webhookUrlChanged && c?.verifiedWebhookUrl ? (
        <div className="res warn" role="status" style={{ marginTop: 16 }}>
          <span className="ic">
            <Icon name="alert" style={{ width: 16, height: 16 }} />
          </span>
          <strong>{C.urlChangedTitle}</strong>
          <p>{C.urlChangedBody}</p>
          <div
            className="kv"
            style={{
              marginTop: 8,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 12px',
              fontSize: 13,
            }}
          >
            <span className="sub">{C.urlSaved}</span>
            <span
              className="num"
              dir="ltr"
              style={{ textDecoration: 'line-through', opacity: 0.6, overflowWrap: 'anywhere' }}
            >
              {c.verifiedWebhookUrl}
            </span>
            <span className="sub">{C.urlCurrent}</span>
            <span className="num" dir="ltr" style={{ overflowWrap: 'anywhere' }}>
              {detail.webhookUrl}
            </span>
          </div>
          <div className="acts">
            <CopyButton value={detail.webhookUrl} label={C.copyNew} className="btn primary" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
