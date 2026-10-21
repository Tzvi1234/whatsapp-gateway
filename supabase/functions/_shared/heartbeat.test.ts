// deno test supabase/functions/_shared/heartbeat.test.ts
import {
  buildEmail,
  emailConfigFrom,
  emailRequestBody,
  formatDuration,
  type HeartbeatNotification,
} from './heartbeat.ts';

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? 'assertEquals'}: expected ${e}, got ${a}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const base: HeartbeatNotification = {
  interval_id: 'i1',
  org_id: 'o1',
  worker_id: 'htz-home-01',
  kind: 'down',
  started_at: '2026-10-21T10:00:00Z',
  detected_at: '2026-10-21T10:03:30Z',
  ended_at: null,
  duration_seconds: null,
};

Deno.test('RL5 formatDuration', () => {
  assertEquals(formatDuration(0), '0s');
  assertEquals(formatDuration(59), '59s');
  assertEquals(formatDuration(240), '4m');
  assertEquals(formatDuration(3725), '1h 2m');
  assertEquals(formatDuration(90061), '1d 1h 1m');
  assertEquals(formatDuration(-5), '0s');
});

Deno.test('RL5 down email names the worker and promises one recovery mail', () => {
  const e = buildEmail(base);
  assert(e.subject.startsWith('[Gateway] DOWN'), e.subject);
  assert(e.text.includes('htz-home-01'), 'worker id in body');
  assert(e.text.includes('exactly one more e-mail'), 'no-repeat promise');
});

Deno.test('RL5 recovered email carries the downtime duration', () => {
  const e = buildEmail({
    ...base,
    kind: 'recovered',
    ended_at: '2026-10-21T10:04:00Z',
    duration_seconds: 240,
  });
  assert(e.subject.includes('RECOVERED') && e.subject.includes('4m'), e.subject);
  assert(e.text.includes('4m'), 'duration in body');
});

Deno.test('dry-run when e-mail env is missing; never a hard-coded address', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(emailConfigFrom(env({})), null);
  assertEquals(
    emailConfigFrom(env({ ALERT_EMAIL_API_KEY: 'k', ALERT_EMAIL_TO: 'a@example.test' })),
    null,
  );
  const cfg = emailConfigFrom(
    env({
      ALERT_EMAIL_API_KEY: 'k',
      ALERT_EMAIL_TO: 'a@example.test, b@example.test',
      ALERT_EMAIL_FROM: 'gw@example.test',
    }),
  );
  assertEquals(cfg?.to, ['a@example.test', 'b@example.test']);
  assertEquals(cfg?.apiUrl, 'https://api.resend.com/emails');
  const body = emailRequestBody(cfg!, buildEmail(base));
  assertEquals(body.to, ['a@example.test', 'b@example.test']);
});
