import Link from 'next/link';
import type { Metadata } from 'next';
import type { AccountCard } from '@/server/actions/read-models';
import { getLiaChannel, type LiaChannel } from '@/server/actions/read-models';
import { listApiKeys } from '@/server/actions/api-keys';
import { Icon, Num } from '@/ui/components/Icon';
import { ResendLiaButton } from '@/ui/components/client';
import { Empty, IssueCard, LoadFailed, NumberRow } from '@/ui/components/server-bits';
import { he } from '@/ui/i18n/he';
import { accountStatusView, deriveIssues, homeHeadline } from '@/ui/lib/account-status';
import { liaPill, pillClass } from '@/ui/lib/lia-status';
import {
  FAILED_RATE_THRESHOLD,
  failedTotals,
  num,
  rowsForDay,
  str,
  weighted,
} from '@/ui/lib/metrics';
import { formatCount, formatDuration, formatPct, formatTime, minutesBetween } from '@/ui/lib/time';
import { healthMetrics, homeData, memberViewer, queueStats } from '@/ui/server/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.app.home };

export default async function HomePage() {
  const viewer = await memberViewer();
  const isOwner = viewer.role === 'owner';
  const [home, health, queue, keys] = await Promise.all([
    homeData(),
    healthMetrics(),
    queueStats(),
    isOwner ? listApiKeys() : Promise.resolve(null),
  ]);
  if (!home.ok) {
    return (
      <>
        <h1>{he.errors.pageTitle}</h1>
        <LoadFailed error={home} />
      </>
    );
  }
  const { accounts, openAlerts, failedRate } = home.data;
  const now = Date.now();

  // Lia channel (owner only: the allowlist holds phone numbers).
  const relay = accounts.find((a) => a.relay) ?? null;
  const lia: LiaChannel | null =
    relay && isOwner ? await getLiaChannel(relay.id).then((r) => (r.ok ? r.data : null)) : null;
  const latestReal = lia?.batches.find((b) => !b.isTest && b.status !== null) ?? null;
  const noReplyBatch = latestReal?.status === 'no_reply' ? latestReal : null;

  const issues = deriveIssues({
    accounts,
    alerts: openAlerts,
    queued: queue.ok ? queue.data.byAccount : {},
    liaNoReplyBatch: relay && noReplyBatch ? { [relay.id]: noReplyBatch.batchId } : {},
    isOwner,
    now,
  });

  // Metrics row (24h).
  const ft = failedTotals(failedRate, '24h');
  const over = ft.rate !== null && ft.rate > FAILED_RATE_THRESHOLD;
  const firstResp = health.ok
    ? weighted(
        rowsForDay(health.data.relayFirstResponse).filter(
          (r) => !lia?.target || str(r, 'relay_target_id') === lia.target.id,
        ),
        'p50_ms',
      )
    : null;
  const configured = accounts.filter((a) => a.status !== 'unconfigured');
  const connected = configured.filter((a) => a.status === 'open').length;
  const sentToday = (a: AccountCard) =>
    health.ok
      ? rowsForDay(health.data.sendLatency)
          .filter((r) => str(r, 'account_id') === a.id)
          .reduce((s, r) => s + (num(r, 'n') ?? 0), 0)
      : 0;

  // "Grok Bot מחובר דרך MCP" topline (owner): the most recently used active key.
  const activeKeys = keys && keys.ok ? keys.data.filter((k) => !k.revokedAt && k.lastUsedAt) : [];
  activeKeys.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
  const lastKey = activeKeys[0] ?? null;

  const liaAside =
    relay && lia ? (
      <aside className="lia-mini" aria-labelledby="lm">
        <div className="row">
          <div
            className="lia-av"
            style={{ width: 36, height: 36, fontSize: 13 }}
            aria-hidden="true"
          >
            Li
          </div>
          <div style={{ flex: 1 }}>
            <strong id="lm">{he.lia.crumbs}</strong>
            <div className="uses">
              {he.lia.statusCardSub(
                relay.provider === 'meta_cloud' ? he.provider.meta_cloud : he.provider.baileys,
              )}
            </div>
          </div>
          {(() => {
            const p = liaPill({
              exists: !!lia.target,
              enabled: lia.target?.enabled ?? false,
              channel: lia.target?.channel ?? 'untested',
              latestStatus: latestReal?.status ?? null,
            });
            return <span className={pillClass(p.tone)}>{p.label}</span>;
          })()}
        </div>
        {noReplyBatch ? (
          <div className="warnline">
            <strong>{he.lia.noReplyFor(minutesBetween(noReplyBatch.createdAt, now))}</strong>{' '}
            <ResendLiaButton batchId={noReplyBatch.batchId} label={he.issue.actResend} small />
            <span className="sub">{he.lia.resendSub}</span>
          </div>
        ) : null}
        {!lia.target ? (
          <p className="uses" style={{ marginTop: 12 }}>
            {he.lia.noTarget}
          </p>
        ) : null}
        <div className="kv">
          <span>{he.lia.sFirst}</span>
          <b className="num">{firstResp !== null ? formatDuration(firstResp) : he.app.dash}</b>
        </div>
        <div className="kv">
          <span>{he.lia.sLastTest}</span>
          <b>
            {lia.target?.lastVerifiedAt ? (
              <>
                {he.lia.lastTestOk('')}
                <Num>{formatTime(lia.target.lastVerifiedAt)}</Num>
              </>
            ) : (
              he.lia.untested
            )}
          </b>
        </div>
        <div style={{ marginTop: 14 }}>
          <Link
            className="btn"
            href={`/numbers/${relay.id}/lia`}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {lia.target ? he.lia.settings : he.lia.noTargetCta}
          </Link>
        </div>
      </aside>
    ) : null;

  const issuesBlock =
    issues.length > 0 ? (
      <div className="issues" style={{ marginTop: liaAside ? 0 : undefined }}>
        {issues.map((i) => (
          <IssueCard key={i.id} issue={i} />
        ))}
      </div>
    ) : (
      <section className="allok" style={{ marginTop: liaAside ? 0 : undefined }}>
        <div className="big">
          <Icon name="check" style={{ width: 22, height: 22 }} />
        </div>
        <h3>{he.home.allOkTitle}</h3>
        <p>{he.home.allOkBody(connected)}</p>
      </section>
    );

  return (
    <>
      <h1>{homeHeadline(issues.length)}</h1>
      <div className="topline">
        {isOwner ? (
          lastKey ? (
            <span className="conn">
              <i />
              {he.home.mcpConnected(lastKey.name)}
              <Num>{formatDuration(now - Date.parse(lastKey.lastUsedAt!))}</Num>
            </span>
          ) : (
            <span className="conn">
              <i style={{ background: 'var(--line)' }} />
              {he.home.mcpNever}
            </span>
          )
        ) : null}
        <span>{he.app.dataWindow}</span>
      </div>
      <dl className="metrics" aria-label={he.home.metricsLabel}>
        <div>
          <dt>{he.home.mSent}</dt>
          <dd className="num" style={{ fontSize: 20 }}>
            {formatCount(ft.total)}
          </dd>
        </div>
        <div className={over ? 'over' : undefined}>
          <dt>{he.home.mFailed}</dt>
          <dd>
            <span className="num">{formatPct(ft.rate)}</span>
            <small>{he.home.mThreshold(formatPct(FAILED_RATE_THRESHOLD, 0))}</small>
          </dd>
        </div>
        <div>
          <dt>{he.home.mLia}</dt>
          <dd>
            <span className="num">
              {firstResp !== null ? formatDuration(firstResp) : he.app.dash}
            </span>
          </dd>
        </div>
        <div>
          <dt>{he.home.mConnected}</dt>
          <dd>
            <span className="num">
              {connected}/{configured.length}
            </span>
          </dd>
        </div>
      </dl>
      {liaAside ? (
        <div className="home-grid" style={{ marginTop: 22 }}>
          {issuesBlock}
          {liaAside}
        </div>
      ) : (
        issuesBlock
      )}
      <h2>
        {he.home.numbersTitle}
        <span className="spacer" />
        {isOwner ? (
          <Link className="btn" href="/connect">
            <Icon name="plus" />
            {he.home.connectCta}
          </Link>
        ) : null}
      </h2>
      {accounts.length === 0 ? (
        <Empty
          title={he.home.noNumbersTitle}
          body={he.home.noNumbersBody}
          action={
            isOwner ? (
              <Link className="btn primary" href="/connect">
                <Icon name="plus" />
                {he.home.connectCta}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <nav className="numbers" aria-label={he.home.numbersTitle}>
          {accounts.map((a) => {
            const v = accountStatusView(a);
            const q = queue.ok ? (queue.data.byAccount[a.id] ?? 0) : 0;
            const sent = sentToday(a);
            const right =
              v.bad && v.since ? (
                <>
                  {he.conn.closedSince}
                  <Num>{formatTime(v.since)}</Num>
                </>
              ) : q > 0 ? (
                he.home.queued(q)
              ) : sent > 0 ? (
                <>
                  <Num>{formatCount(sent)}</Num> {he.number.kSent}
                </>
              ) : (
                v.label
              );
            return <NumberRow key={a.id} a={a} right={right} />;
          })}
        </nav>
      )}
    </>
  );
}
