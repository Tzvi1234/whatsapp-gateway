import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getAccountDetail,
  getLiaChannel,
  type HealthMetrics,
  type LiaChannel,
} from '@/server/actions/read-models';
import { Num } from '@/ui/components/Icon';
import { ResendLiaButton, WhatToCheck } from '@/ui/components/client';
import {
  CloudCredsCard,
  FailedMessages,
  HourStrip,
  PrimaryAction,
  ProviderBars,
  SessionEvents,
} from '@/ui/components/NumberParts';
import { ConnPill, Crumbs, LoadFailed, ProviderBadge } from '@/ui/components/server-bits';
import { he } from '@/ui/i18n/he';
import { useCasesText } from '@/ui/lib/account-status';
import { buildHourStrip } from '@/ui/lib/strip';
import { liaPill, pillClass } from '@/ui/lib/lia-status';
import { barPct, num, rowsForDay, str, transcriptByBucket, weighted } from '@/ui/lib/metrics';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatPct,
  formatSeconds,
  jerusalemDay,
} from '@/ui/lib/time';
import { healthMetrics, homeData, memberViewer, queueStats } from '@/ui/server/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.number.crumbs };

const N = he.number;

export default async function NumberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await memberViewer();
  const isOwner = viewer.role === 'owner';
  const [detailR, health, queue, home] = await Promise.all([
    getAccountDetail(id),
    healthMetrics(),
    queueStats(),
    homeData(),
  ]);
  if (!detailR.ok) {
    if (detailR.code === 'not_found') notFound();
    return (
      <>
        <Crumbs>{N.crumbs}</Crumbs>
        <LoadFailed error={detailR} retryHref={`/numbers/${id}`} />
      </>
    );
  }
  const d = detailR.data;
  const a = d.account;
  const now = Date.now();
  const relay = a.relay;
  const lia: LiaChannel | null =
    relay && isOwner ? await getLiaChannel(a.id).then((r) => (r.ok ? r.data : null)) : null;

  const failed24 = d.failedMessages.filter(
    (m) => now - Date.parse(m.createdAt) < 86_400_000,
  ).length;
  const queued = queue.ok ? (queue.data.byAccount[a.id] ?? 0) : null;
  const latencyToday = health.ok
    ? rowsForDay(health.data.sendLatency).filter((r) => str(r, 'account_id') === a.id)
    : [];
  const sentToday = latencyToday.reduce((s, r) => s + (num(r, 'n') ?? 0), 0);
  const p50Send = weighted(latencyToday, 'p50_ms');

  return (
    <>
      <Crumbs>{N.crumbs}</Crumbs>
      <h1>{a.label}</h1>
      <div className="topline">
        <ProviderBadge provider={a.provider} />
        <span>
          {useCasesText(a)}
          {a.phoneDisplay ? (
            <>
              {' · '}
              <Num>{a.phoneDisplay}</Num>
            </>
          ) : null}
        </span>
        <ConnPill
          account={a}
          since={buildHourStrip(d.sessionEvents, [], a.status, now).downSince}
        />
        <span className="spacer" style={{ flex: 1 }} />
        {isOwner ? <PrimaryAction a={a} relay={relay} /> : null}
      </div>

      <HourStrip detail={d} now={now} />

      {relay ? (
        <LiaSections
          accountId={a.id}
          lia={lia}
          isOwner={isOwner}
          health={health.ok ? health.data : null}
        />
      ) : (
        <dl className="kpis">
          <div className="kpi">
            <dt>{N.kFailed}</dt>
            <dd>
              <span className="num">{failed24}</span> <small>{N.kFailedSub}</small>
            </dd>
          </div>
          <div className="kpi">
            <dt>{N.kQueued}</dt>
            <dd className="num">{queued === null ? he.app.dash : queued}</dd>
          </div>
          <div className="kpi">
            <dt>{N.kSent}</dt>
            <dd>
              <span className="num">{formatCount(sentToday)}</span>
              {p50Send !== null ? (
                <small>
                  {' '}
                  · {N.kLatency} <Num>{formatDuration(p50Send)}</Num>
                </small>
              ) : null}
            </dd>
          </div>
        </dl>
      )}

      {a.provider === 'meta_cloud' && isOwner ? <CloudCredsCard detail={d} /> : null}
      {home.ok ? <ProviderBars rows={home.data.failedRate} /> : null}
      <FailedMessages items={d.failedMessages} canAct={isOwner} />
      <SessionEvents items={d.sessionEvents} />
    </>
  );
}

/** number-lia.html: Lia KPIs, response time, transcription latency by length (Reviewer fix). */
function LiaSections({
  accountId,
  lia,
  isOwner,
  health,
}: {
  accountId: string;
  lia: LiaChannel | null;
  isOwner: boolean;
  health: HealthMetrics | null;
}) {
  const today = jerusalemDay(Date.now());
  const batches = lia?.batches ?? [];
  const real = batches.filter((b) => !b.isTest);
  const todayCount = real.filter((b) => jerusalemDay(b.createdAt) === today).length;
  const undelivered = real.filter((b) => b.status === 'delivery_failed').length;
  const targetId = lia?.target?.id ?? null;
  const fr = health
    ? health.relayFirstResponse.filter((r) => !targetId || str(r, 'relay_target_id') === targetId)
    : [];
  const frToday = rowsForDay(fr);
  const p50 = weighted(frToday.length ? frToday : fr, 'p50_ms');
  const p95 = weighted(frToday.length ? frToday : fr, 'p95_ms');
  const nr = health
    ? health.relayNoReplyRate.filter((r) => !targetId || str(r, 'relay_target_id') === targetId)
    : [];
  const nrDelivered = nr.reduce((s, r) => s + (num(r, 'delivered_or_final') ?? 0), 0);
  const nrNo = nr.reduce((s, r) => s + (num(r, 'no_reply') ?? 0), 0);
  const tr = health ? transcriptByBucket(health.transcriptLatency, accountId) : [];
  const transcribed = tr.reduce((s, b) => s + b.n, 0);
  const maxP50 = Math.max(0, ...tr.map((b) => b.p50 ?? 0));

  return (
    <>
      <dl className="kpis">
        <div className="kpi">
          <dt>{N.kLiaToday}</dt>
          <dd className="num">{lia ? todayCount : he.app.dash}</dd>
        </div>
        <div className="kpi">
          <dt>{N.kTranscribed}</dt>
          <dd className="num">{health ? transcribed : he.app.dash}</dd>
        </div>
        <div className="kpi">
          <dt>{N.kUndelivered}</dt>
          <dd className="num">{lia ? undelivered : he.app.dash}</dd>
        </div>
      </dl>
      <section className="card" style={{ marginTop: 16 }}>
        <div
          className="toggle"
          style={{ marginTop: 0, paddingTop: 0, borderTop: 0, flexWrap: 'wrap' }}
        >
          <strong style={{ flex: 1 }}>{N.liaResponse}</strong>
          <span className="uses">
            {p50 !== null ? (
              <>
                {he.health.median} <Num>{formatDuration(p50)}</Num> · {he.health.p95}{' '}
                <Num>{formatDuration(p95)}</Num>
                {nrDelivered > 0 ? (
                  <>
                    {' · '}
                    {he.lia.sNoReply} <Num>{formatPct(nrNo / nrDelivered)}</Num>
                  </>
                ) : null}
              </>
            ) : (
              he.app.noData
            )}
          </span>
        </div>
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 4, paddingTop: 16 }}>
          <strong>{N.transcriptTitle}</strong>
          <p className="uses" style={{ marginTop: 2 }}>
            {N.transcriptSub}
          </p>
          {tr.length === 0 ? (
            <p className="uses" style={{ marginTop: 10 }}>
              {N.transcriptEmpty}
            </p>
          ) : (
            <div className="bars tr">
              {tr.map((b) => (
                <div key={b.bucket}>
                  <span>{he.transcriptBuckets[b.bucket] ?? b.bucket}</span>
                  <i>
                    <b
                      style={{
                        width: `${barPct(b.p50, maxP50)}%`,
                        ...(b.p50 !== null && b.p50 > 60 ? { background: 'var(--warn)' } : {}),
                      }}
                    />
                  </i>
                  <span className="num">{formatSeconds(b.p50)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      {isOwner ? (
        <section className="card" style={{ marginTop: 16 }} aria-labelledby="lb">
          <strong id="lb">{N.batchesTitle}</strong>
          {real.length === 0 ? (
            <p className="uses" style={{ marginTop: 8 }}>
              {N.batchesEmpty}
            </p>
          ) : (
            <ul className="rows">
              {real.slice(0, 10).map((b) => {
                const p = liaPill({
                  exists: true,
                  enabled: true,
                  channel: 'verified',
                  latestStatus: b.status,
                });
                return (
                  <li key={b.batchId}>
                    <div>
                      <span className={pillClass(p.tone)}>
                        {b.status === null ? he.liaResult.retrying.title : p.label}
                      </span>
                      <small>
                        <Num>{formatDateTime(b.createdAt)}</Num> · {he.lia.attempts(b.attempts)}
                      </small>
                    </div>
                    <div className="acts">
                      {b.status === 'no_reply' || b.status === 'unreachable' ? (
                        <ResendLiaButton batchId={b.batchId} small />
                      ) : null}
                    </div>
                    <WhatToCheck codes={[b.status ?? 'pending']} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <p className="uses" style={{ marginTop: 16 }}>
          {N.memberOnly}
        </p>
      )}
    </>
  );
}
