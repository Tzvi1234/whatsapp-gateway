import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccountDetail, getLiaChannel } from '@/server/actions/read-models';
import { getAllowlistAudit } from '@/server/actions/dashboard-extra';
import { Num } from '@/ui/components/Icon';
import { LiaSetup } from '@/ui/components/LiaSetup';
import { LoadFailed } from '@/ui/components/server-bits';
import { he } from '@/ui/i18n/he';
import { liaPill, pillClass } from '@/ui/lib/lia-status';
import { num, rowsForDay, str, weighted } from '@/ui/lib/metrics';
import { formatDateTime, formatDuration, formatPct } from '@/ui/lib/time';
import { healthMetrics } from '@/ui/server/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.lia.crumbs };

const L = he.lia;

export default async function LiaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, channel, health] = await Promise.all([
    getAccountDetail(id),
    getLiaChannel(id),
    healthMetrics(),
  ]);
  if (!detail.ok && detail.code === 'not_found') notFound();
  const crumbs = (
    <nav className="crumbs" aria-label="פירורי לחם">
      <Link href="/">{he.app.home}</Link> ·{' '}
      {detail.ok ? <Link href={`/numbers/${id}`}>{detail.data.account.label}</Link> : null}
      {detail.ok ? ' · ' : null}
      {L.crumbs}
    </nav>
  );
  if (!detail.ok || !channel.ok) {
    const err = !detail.ok ? detail : !channel.ok ? channel : null;
    return (
      <>
        {crumbs}
        <h1>{L.h1}</h1>
        {err ? <LoadFailed error={err} retryHref={`/numbers/${id}/lia`} /> : null}
      </>
    );
  }
  const a = detail.data.account;
  const target = channel.data.target;
  const audit = target ? await getAllowlistAudit(target.id) : null;
  const latestTest = channel.data.batches.find((b) => b.isTest) ?? null;
  const latestReal = channel.data.batches.find((b) => !b.isTest && b.status !== null) ?? null;
  const pill = liaPill({
    exists: !!target,
    enabled: target?.enabled ?? false,
    channel: target?.channel ?? 'untested',
    latestStatus: latestReal?.status ?? null,
  });

  const fr =
    health.ok && target
      ? health.data.relayFirstResponse.filter((r) => str(r, 'relay_target_id') === target.id)
      : [];
  const frToday = rowsForDay(fr);
  const p50 = weighted(frToday.length ? frToday : fr, 'p50_ms');
  const nr =
    health.ok && target
      ? health.data.relayNoReplyRate.filter((r) => str(r, 'relay_target_id') === target.id)
      : [];
  const nrDen = nr.reduce((s, r) => s + (num(r, 'delivered_or_final') ?? 0), 0);
  const nrNo = nr.reduce((s, r) => s + (num(r, 'no_reply') ?? 0), 0);
  const untested = !target || target.channel === 'untested';

  return (
    <>
      {crumbs}
      <h1>{untested ? L.h1Setup : L.h1}</h1>
      <p className="lead">{L.lead}</p>
      {untested ? (
        <div className="topline" style={{ marginTop: 14 }}>
          <span className="pill">{L.untested}</span>
          <span>{L.untestedExplain}</span>
        </div>
      ) : null}

      {target ? (
        <section className="card" style={{ marginTop: 20 }} aria-labelledby="lia-status">
          <div className="lia-head">
            <div className="lia-av" aria-hidden="true">
              Li
            </div>
            <div style={{ flex: 1 }}>
              <h3 id="lia-status">{target.name}</h3>
              <small>
                {L.statusCardSub(
                  a.provider === 'meta_cloud' ? he.provider.meta_cloud : he.provider.baileys,
                )}
                {a.phoneDisplay ? (
                  <>
                    {' · '}
                    <Num>{a.phoneDisplay}</Num>
                  </>
                ) : null}
              </small>
            </div>
            <span className={pillClass(pill.tone)}>{pill.label}</span>
          </div>
          <dl className="stats">
            <div>
              <dt>{L.sFirst}</dt>
              <dd>
                <Num>{p50 !== null ? formatDuration(p50) : he.app.dash}</Num>
              </dd>
            </div>
            <div>
              <dt>{L.sNoReply}</dt>
              <dd>
                <Num>{nrDen > 0 ? formatPct(nrNo / nrDen) : he.app.dash}</Num>
              </dd>
            </div>
            <div>
              <dt>{L.sLastTest}</dt>
              <dd>
                {target.lastVerifiedAt ? (
                  <>
                    {L.lastTestOk('')}
                    <Num>{formatDateTime(target.lastVerifiedAt)}</Num>
                  </>
                ) : (
                  L.untested
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div style={{ marginTop: 20 }}>
        <LiaSetup
          accountId={a.id}
          provider={a.provider}
          phoneDisplay={a.phoneDisplay}
          initialTarget={target}
          latestTestBatchId={latestTest?.batchId ?? null}
          audit={audit && audit.ok ? audit.data : null}
        />
      </div>
    </>
  );
}
