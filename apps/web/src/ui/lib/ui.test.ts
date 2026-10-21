import { describe, expect, it } from 'vitest';
import { LIA_TEST_STATUSES, type LiaTestResult, type LiaTestStatus } from '@htz/core';
import type { AccountCard, AlertView } from '@/server/actions/read-models';
import { he, joinHe } from '../i18n/he';
import { deriveIssues, homeHeadline, useCasesText } from './account-status';
import { authRedirectFor, safeNext } from './auth-redirect';
import { inWaitingWindow, liaPill, liaResultView } from './lia-status';
import { failedTotals, quantile, transcriptByBucket } from './metrics';
import { correctPhone, displayFromJid } from './phone';
import { buildHourStrip } from './strip';
import { formatCountdown, formatDuration, formatTime } from './time';

const test = (status: LiaTestStatus, extra: Partial<LiaTestResult> = {}): LiaTestResult => ({
  status,
  reason: status === 'accepted' ? 'http_2xx' : `reason_${status}`,
  elapsed_ms: 1000,
  ...extra,
});

/** Any canonical enum value or snake_case code leaking into user-facing copy. */
function leaks(text: string): string[] {
  const found: string[] = [];
  for (const s of LIA_TEST_STATUSES) if (new RegExp(`\\b${s}\\b`).test(text)) found.push(s);
  if (/\buntested\b/.test(text)) found.push('untested');
  const snake = text.match(/\b[a-z]+_[a-z_]+\b/g);
  if (snake) found.push(...snake);
  return found;
}

function mainCopy(v: ReturnType<typeof liaResultView>): string {
  return [
    v.title,
    v.body ?? '',
    v.sub ?? '',
    ...v.actions.map((a) => a.label),
    ...v.timeline.map((t) => t.label),
  ].join(' ');
}

describe('Lia status copy', () => {
  it('L5.2 save without test: channel shows "לא נבדק"', () => {
    expect(
      liaPill({ exists: true, enabled: true, channel: 'untested', latestStatus: null }),
    ).toEqual({
      tone: 'neutral',
      label: 'לא נבדק',
    });
    expect(liaResultView(null).key).toBe('none');
  });

  it('L5.3 a test that only reached accepted keeps the channel "לא נבדק"', () => {
    const p = liaPill({
      exists: true,
      enabled: true,
      channel: 'untested',
      latestStatus: 'accepted',
    });
    expect(p.label).toBe(he.liaPill.untested);
  });

  it('L5.4 replied → verified channel shows an OK pill', () => {
    expect(
      liaPill({ exists: true, enabled: true, channel: 'verified', latestStatus: 'replied' }),
    ).toEqual({
      tone: 'ok',
      label: he.liaPill.verified,
    });
  });

  it('L4.1 replied shows the received / replied times', () => {
    const v = liaResultView(test('replied', { received_ms: 400, reply_ms: 38_000 }));
    expect(v.tone).toBe('ok');
    expect(v.title).toBe('החיבור עובד');
    expect(v.timeline.map((t) => t.value)).toEqual(['0.4s', '38s']);
    expect(v.actions[0]?.kind).toBe('finish');
  });

  it('L4.2 accepted + waiting is "ממתין לתשובה", never a failure — also after 2 minutes', () => {
    for (const t of [
      test('accepted', { waiting: true, elapsed_ms: 30_000 }),
      test('accepted', { waiting: true, elapsed_ms: 150_000 }),
      test('accepted', { elapsed_ms: 9 * 60_000 }),
    ]) {
      const v = liaResultView(t, { thresholdMin: 10 });
      expect(v.tone).toBe('wait');
      expect(v.title).toBe('התקבל, ממתינים לתשובה');
      expect(v.body).toContain('זה לא כישלון');
      expect(v.body).toContain('10 דקות');
    }
    expect(inWaitingWindow(test('accepted', { waiting: true, elapsed_ms: 10_000 }))).toBe(true);
    expect(
      liaPill({ exists: true, enabled: true, channel: 'verified', latestStatus: 'accepted' }).label,
    ).toBe('ממתין לתשובה');
  });

  it('L4.3 no_reply → "לא ענתה" in warning colour, resend the same batch', () => {
    const v = liaResultView(test('no_reply'), { thresholdMin: 30 });
    expect(v.tone).toBe('warn');
    expect(v.title).toBe('Lia לא ענתה');
    expect(v.body).toContain('30 דקות');
    expect(v.actions.map((a) => a.kind)).toEqual(['resend', 'save_anyway']);
    expect(v.sub).toBe(he.lia.resendSub);
    expect(
      liaPill({ exists: true, enabled: true, channel: 'verified', latestStatus: 'no_reply' }),
    ).toEqual({
      tone: 'warn',
      label: 'לא ענתה',
    });
  });

  it('L4.4 rejected_key → wrong key, replace it', () => {
    const v = liaResultView(test('rejected_key'));
    expect(v.tone).toBe('bad');
    expect(v.actions[0]?.kind).toBe('replace_key');
  });

  it('L4.5 unreachable → cannot reach Lia, retry', () => {
    const v = liaResultView(test('unreachable'));
    expect(v.tone).toBe('bad');
    expect(v.actions[0]?.kind).toBe('retry');
  });

  it('L4.6 delivery_failed → reply kept, action "scan again"', () => {
    const v = liaResultView(test('delivery_failed'));
    expect(v.tone).toBe('bad');
    expect(v.actions[0]?.kind).toBe('rescan');
    expect(v.actions[0]?.label).toContain('סריקה מחדש');
  });

  it('L4.10 every canonical status has a view, and only canonical statuses are recognised', () => {
    for (const s of LIA_TEST_STATUSES) expect(liaResultView(test(s)).key).toBe(s);
    expect(
      liaResultView({ status: 'waiting' as LiaTestStatus, reason: 'x', elapsed_ms: 0 }).key,
    ).toBe('none');
  });

  it('L5.8 no raw enum / code strings in the main copy; codes only under "מה לבדוק"', () => {
    for (const s of LIA_TEST_STATUSES) {
      const v = liaResultView(test(s));
      expect(leaks(mainCopy(v)), s).toEqual([]);
      expect(v.codes).toContain(s);
    }
    for (const phase of ['sending', 'retrying'] as const) {
      expect(leaks(mainCopy(liaResultView(null, { phase })))).toEqual([]);
    }
    expect(leaks(mainCopy(liaResultView(null)))).toEqual([]);
    for (const label of Object.values(he.liaPill)) expect(leaks(label)).toEqual([]);
    for (const latest of [null, ...LIA_TEST_STATUSES]) {
      for (const channel of ['untested', 'verified'] as const) {
        expect(
          leaks(liaPill({ exists: true, enabled: true, channel, latestStatus: latest }).label),
        ).toEqual([]);
      }
    }
  });

  it('Reviewer fix: status-card header pill is words only (no technical tags)', () => {
    for (const latest of [null, ...LIA_TEST_STATUSES]) {
      const p = liaPill({ exists: true, enabled: true, channel: 'verified', latestStatus: latest });
      expect(p.label).toMatch(/^[֐-׿\s]+$/);
    }
  });
});

describe('C7 live phone correction', () => {
  it.each(['0559014410', '055-901-4410', '+972 55 901 4410', '972559014410'])(
    'C7 %s is shown corrected as +972 55-901-4410, not as an error',
    (input) => {
      const c = correctPhone(input);
      expect(c).toMatchObject({
        state: 'corrected',
        e164: '+972559014410',
        display: '+972 55-901-4410',
      });
    },
  );

  it('C7 partial input is "typing", not an error', () => {
    expect(correctPhone('05').state).toBe('typing');
    expect(correctPhone('055-901-44').state).toBe('typing');
    expect(correctPhone('+97').state).toBe('typing');
    expect(correctPhone('').state).toBe('empty');
  });

  it('C7 garbage, too long and non-IL numbers are rejected', () => {
    expect(correctPhone('abc').state).toBe('invalid');
    expect(correctPhone('05590144100').state).toBe('invalid');
    expect(correctPhone('+1 555 123 4567').state).toBe('invalid');
  });

  it('C7 jid → display', () => {
    expect(displayFromJid('972559014410@s.whatsapp.net')).toBe('+972 55-901-4410');
    expect(displayFromJid('12345-678@g.us')).toBeNull();
  });
});

const card = (o: Partial<AccountCard>): AccountCard => ({
  id: 'a1',
  label: 'מספרה רונן',
  provider: 'baileys',
  alias: null,
  phoneE164: '+972543182207',
  phoneDisplay: '+972 54-318-2207',
  status: 'open',
  connection: 'open',
  lastHeartbeatAt: '2026-10-21T09:00:00Z',
  lastErrorCode: null,
  allowedUseCases: ['status_automation'],
  relay: false,
  isTest: false,
  capabilities: {} as AccountCard['capabilities'],
  ...o,
});

describe('home issues (direction C)', () => {
  const now = Date.parse('2026-10-21T09:12:00Z');

  it('R5.5 needs_relink becomes a sentence with one fix (scan again) and the queued count', () => {
    const issues = deriveIssues({
      accounts: [card({ status: 'needs_relink' })],
      alerts: [],
      queued: { a1: 4 },
      isOwner: true,
      now,
    });
    expect(issues).toHaveLength(1);
    const i = issues[0]!;
    expect(i.crit).toBe(true);
    expect(`${i.say.pre}${i.say.em}${i.say.post}`).toBe(
      'המספר של מספרה רונן התנתק לפני 12 דקות, ו-4 הודעות מחכות לו.',
    );
    expect(i.action).toMatchObject({ kind: 'link', href: '/connect?account=a1&method=qr' });
  });

  it('C1 non-owners get "what happened" instead of an owner-only fix', () => {
    const [i] = deriveIssues({
      accounts: [card({ status: 'conflict' })],
      alerts: [],
      isOwner: false,
      now,
    });
    expect(i!.action).toMatchObject({ kind: 'link', href: '/numbers/a1' });
  });

  it('dead letters are grouped per number with a resend action; down alerts are not duplicated', () => {
    const alerts: AlertView[] = [
      {
        id: 'x1',
        severity: 'P2',
        kind: 'dead_letter',
        accountId: 'a1',
        message: null,
        openedAt: '2026-10-21T08:00:00Z',
      },
      {
        id: 'x2',
        severity: 'P2',
        kind: 'dead_letter',
        accountId: 'a1',
        message: null,
        openedAt: '2026-10-21T08:30:00Z',
      },
      {
        id: 'x3',
        severity: 'P1',
        kind: 'needs_relink',
        accountId: 'a2',
        message: null,
        openedAt: '2026-10-21T09:00:00Z',
      },
    ];
    const issues = deriveIssues({
      accounts: [card({}), card({ id: 'a2', status: 'needs_relink', label: 'Lia' })],
      alerts,
      isOwner: true,
      now,
    });
    expect(issues.map((i) => i.code)).toEqual(['needs_relink', 'dead_letter']);
    expect(issues[1]!.say.pre).toContain('2 הודעות');
    for (const i of issues)
      expect(leaks(`${i.say.pre}${i.say.em}${i.say.post} ${i.why}`)).toEqual([]);
  });

  it('headline counts issues in words', () => {
    expect(homeHeadline(0)).toBe('הכול עובד');
    expect(homeHeadline(1)).toBe('דבר אחד צריך אותך');
    expect(homeHeadline(2)).toBe('שני דברים צריכים אותך');
    expect(homeHeadline(5)).toBe('5 דברים צריכים אותך');
  });

  it('ARCH 7.6 allowed use cases are listed in Hebrew', () => {
    expect(useCasesText(card({ allowedUseCases: ['customer_service', 'reminders'] }))).toBe(
      'שירות לקוחות ותזכורות',
    );
    expect(useCasesText(card({ relay: true }))).toBe('הערוץ האישי שלך');
    expect(joinHe(['א', 'ב', 'ג'])).toBe('א, ב וג');
  });
});

describe('display helpers', () => {
  it('R5.5 times are shown in Asia/Jerusalem', () => {
    expect(formatTime('2026-10-21T09:05:00Z')).toBe('12:05');
    expect(formatTime('2026-12-01T09:05:00Z')).toBe('11:05');
  });

  it('durations and countdowns match the mockups', () => {
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(48_000)).toBe('48s');
    expect(formatDuration(112_000)).toBe('1m 52s');
    expect(formatDuration(11 * 60_000)).toBe('11m');
    expect(formatCountdown(161_000)).toBe('2:41');
  });

  it('24h strip marks the outage onset and the down hours', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const s = buildHourStrip(
      [
        { event: 'open', at: '2026-10-19T08:00:00Z' },
        { event: 'needs_relink', at: '2026-10-21T10:30:00Z' },
      ],
      [],
      'needs_relink',
      now,
    );
    expect(s.slots).toHaveLength(24);
    expect(s.slots.slice(0, 22).every((x) => x === 'ok')).toBe(true);
    expect(s.slots.slice(22)).toEqual(['c', 'c']);
    expect(s.downSince).toBe('2026-10-21T10:30:00Z');
    expect(s.onsetPct).toBeCloseTo(93.8, 0);
  });

  it('strip shows "no data" for a number that never connected', () => {
    expect(buildHourStrip([], [], 'unconfigured').slots.every((x) => x === 'n')).toBe(true);
  });

  it('metrics: failed totals, quantiles and transcript buckets by recording length', () => {
    const rows = [
      { provider: 'baileys', window: '24h', total: 88, failed: 6, rate: 0 },
      { provider: 'meta_cloud', window: '24h', total: 12, failed: 0, rate: 0 },
      { provider: 'baileys', window: '7d', total: 500, failed: 9, rate: 0 },
    ];
    expect(failedTotals(rows, '24h')).toEqual({ total: 100, failed: 6, rate: 0.06 });
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const tr = transcriptByBucket(
      [
        { account_id: 'a', length_bucket: '0-15s', n: 3, p50_s: 9, p90_s: 12 },
        { account_id: 'a', length_bucket: '120s+', n: 1, p50_s: 112, p90_s: 112 },
        { account_id: 'b', length_bucket: '0-15s', n: 9, p50_s: 99, p90_s: 99 },
      ],
      'a',
    );
    expect(tr.map((b) => [b.bucket, b.p50])).toEqual([
      ['0-15s', 9],
      ['120s+', 112],
    ]);
  });

  it('R5.2 auth failures route to login / mfa / forbidden; next stays same-origin', () => {
    expect(authRedirectFor('unauthenticated', '/connect')).toBe('/login?next=%2Fconnect');
    expect(authRedirectFor('mfa_required', '/')).toBe('/mfa?next=%2F');
    expect(authRedirectFor('not_owner')).toBe('/forbidden');
    expect(authRedirectFor('invalid_token')).toBeNull();
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
  });
});
