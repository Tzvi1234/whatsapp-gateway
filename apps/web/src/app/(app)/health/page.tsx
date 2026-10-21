import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Num } from '@/ui/components/Icon';
import { LoadFailed } from '@/ui/components/server-bits';
import { he } from '@/ui/i18n/he';
import {
  barPct,
  failedTotals,
  latestDayRows,
  median,
  num,
  quantile,
  str,
  transcriptByBucket,
  weighted,
} from '@/ui/lib/metrics';
import {
  formatCount,
  formatDuration,
  formatPct,
  formatSeconds,
  formatTime,
  minutesBetween,
} from '@/ui/lib/time';
import { healthMetrics, homeData, queueStats } from '@/ui/server/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.health.h1 };

const H = he.health;

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Pair({ a, b }: { a: [string, ReactNode]; b: [string, ReactNode] }) {
  return (
    <dl className="kv2">
      <dt>{a[0]}</dt>
      <dd>{a[1]}</dd>
      <dt>{b[0]}</dt>
      <dd>{b[1]}</dd>
    </dl>
  );
}

const PROVIDERS = ['baileys', 'meta_cloud'] as const;

export default async function HealthPage() {
  const [m, home, queue] = await Promise.all([healthMetrics(), homeData(), queueStats()]);
  if (!m.ok) {
    return (
      <>
        <h1>{H.h1}</h1>
        <LoadFailed error={m} retryHref="/health" />
      </>
    );
  }
  const d = m.data;
  const fr = home.ok
    ? home.data.failedRate
    : d.failedRateByProvider.map((r) => ({
        provider: str(r, 'provider') ?? '',
        window: str(r, 'window_name') ?? '',
        total: num(r, 'total') ?? 0,
        failed: num(r, 'failed') ?? 0,
        rate: num(r, 'failed_rate') ?? 0,
      }));
  const life = d.sessionLifetime
    .map((r) => num(r, 'lifetime_s'))
    .filter((x): x is number => x !== null);
  const rec = d.reconnectTime
    .map((r) => num(r, 'reconnect_s'))
    .filter((x): x is number => x !== null);
  const sendLatest = latestDayRows(d.sendLatency);
  const liaLatest = latestDayRows(d.relayFirstResponse);
  const nrDen = d.relayNoReplyRate.reduce((s, r) => s + (num(r, 'delivered_or_final') ?? 0), 0);
  const nrNo = d.relayNoReplyRate.reduce((s, r) => s + (num(r, 'no_reply') ?? 0), 0);
  const tr = transcriptByBucket(d.transcriptLatency);
  const trMax = Math.max(0, ...tr.map((b) => b.p50 ?? 0));
  const toConnect = d.firstConnectFunnel
    .map((r) => num(r, 'to_connect_s'))
    .filter((x): x is number => x !== null);
  const toFirst = d.firstConnectFunnel
    .map((r) => num(r, 'to_first_message_s'))
    .filter((x): x is number => x !== null);
  const worker = home.ok ? home.data.worker : null;

  const maxRate = Math.max(0.05, ...fr.map((r) => r.rate));

  return (
    <>
      <h1>{H.h1}</h1>
      <p className="lead">{H.lead}</p>
      <div className="health-grid">
        <Card title={H.failedByProvider}>
          <div className="bars wide">
            {PROVIDERS.flatMap((p) =>
              (['24h', '7d'] as const).map((w) => {
                const t = failedTotals(fr, w, p);
                return (
                  <div key={`${p}-${w}`}>
                    <span>
                      {he.provider[p]} · {w === '24h' ? H.w24 : H.w7}
                    </span>
                    <i>
                      <b
                        style={{
                          width: `${barPct(t.rate, maxRate)}%`,
                          ...(p === 'meta_cloud' ? { background: 'var(--cloud)' } : {}),
                        }}
                      />
                    </i>
                    <span className="v">
                      <Num>{formatPct(t.rate)}</Num>
                      <small className="uses"> {H.ofTotal(formatCount(t.total))}</small>
                    </span>
                  </div>
                );
              }),
            )}
          </div>
        </Card>
        <Card title={H.queue}>
          {queue.ok ? (
            queue.data.total === 0 ? (
              <p className="uses" style={{ marginTop: 10 }}>
                {H.queueEmpty}
              </p>
            ) : (
              <Pair
                a={[H.queueDepth, <Num key="d">{formatCount(queue.data.total)}</Num>]}
                b={[
                  H.queueOldest,
                  <Num key="o">
                    {queue.data.oldestRunAt
                      ? formatDuration(minutesBetween(queue.data.oldestRunAt) * 60_000)
                      : he.app.dash}
                  </Num>,
                ]}
              />
            )
          ) : (
            <p className="uses" style={{ marginTop: 10 }}>
              {H.queueUnavailable}
            </p>
          )}
          <p className="uses" style={{ marginTop: 12 }}>
            {H.worker}:{' '}
            {worker ? (
              <>
                {H.workerSeen('')}
                <Num>{formatTime(worker.at)}</Num>
              </>
            ) : (
              H.workerNever
            )}
          </p>
        </Card>
        <Card title={H.sessionLifetime}>
          <Pair
            a={[H.median, <Num key="m">{formatSeconds(median(life))}</Num>]}
            b={[H.p90, <Num key="p">{formatSeconds(quantile(life, 0.9))}</Num>]}
          />
          <p className="uses" style={{ marginTop: 8 }}>
            {H.samples(life.length)}
          </p>
        </Card>
        <Card title={H.reconnect}>
          <Pair
            a={[H.median, <Num key="m">{formatSeconds(median(rec))}</Num>]}
            b={[H.p90, <Num key="p">{formatSeconds(quantile(rec, 0.9))}</Num>]}
          />
          <p className="uses" style={{ marginTop: 8 }}>
            {H.samples(rec.length)}
          </p>
        </Card>
        <Card title={H.sendLatency}>
          {sendLatest.length === 0 ? (
            <p className="uses" style={{ marginTop: 10 }}>
              {he.app.noData}
            </p>
          ) : (
            <dl className="kv2">
              {PROVIDERS.map((p) => {
                const rows = sendLatest.filter((r) => str(r, 'provider') === p);
                if (rows.length === 0) return null;
                return (
                  <div key={p} style={{ display: 'contents' }}>
                    <dt>{he.provider[p]}</dt>
                    <dd>
                      {H.median} <Num>{formatDuration(weighted(rows, 'p50_ms'))}</Num> · {H.p95}{' '}
                      <Num>{formatDuration(weighted(rows, 'p95_ms'))}</Num>
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </Card>
        <Card title={H.liaFirst}>
          <Pair
            a={[H.median, <Num key="m">{formatDuration(weighted(liaLatest, 'p50_ms'))}</Num>]}
            b={[H.p95, <Num key="p">{formatDuration(weighted(liaLatest, 'p95_ms'))}</Num>]}
          />
          <p className="uses" style={{ marginTop: 10 }}>
            {H.liaNoReply}: <Num>{nrDen > 0 ? formatPct(nrNo / nrDen) : he.app.dash}</Num>
          </p>
        </Card>
        <Card title={H.transcript}>
          {tr.length === 0 ? (
            <p className="uses" style={{ marginTop: 10 }}>
              {he.app.noData}
            </p>
          ) : (
            <div className="bars tr wide">
              {tr.map((b) => (
                <div key={b.bucket}>
                  <span>{he.transcriptBuckets[b.bucket] ?? b.bucket}</span>
                  <i>
                    <b
                      style={{
                        width: `${barPct(b.p50, trMax)}%`,
                        ...(b.p50 !== null && b.p50 > 60 ? { background: 'var(--warn)' } : {}),
                      }}
                    />
                  </i>
                  <span className="v">
                    <Num>{formatSeconds(b.p50)}</Num>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title={H.funnel}>
          <Pair
            a={[H.funnelConnect, <Num key="c">{formatSeconds(median(toConnect))}</Num>]}
            b={[H.funnelFirst, <Num key="f">{formatSeconds(median(toFirst))}</Num>]}
          />
        </Card>
      </div>
    </>
  );
}
