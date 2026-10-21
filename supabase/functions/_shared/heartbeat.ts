// Pure logic for the server-down e-mails (ARCH §8.3, TEST-PLAN RL5). No I/O here.
//
// The state machine itself is transactional in Postgres:
//   heartbeat_evaluate()            up -> down when last heartbeat > 3 min ago (opens ONE outage row)
//   record_heartbeat()              down -> up on the next heartbeat (closes that outage row)
//   heartbeat_claim_notifications() mails owed per outage: "down" once, "recovered" once (leased)
//   heartbeat_ack_notification()    marks a mail sent, so it is never sent again
// This module decides what each mail says and whether e-mail is configured.

export type NotificationKind = 'down' | 'recovered';

export interface HeartbeatNotification {
  interval_id: string;
  org_id: string;
  worker_id: string;
  kind: NotificationKind;
  started_at: string; // last heartbeat seen
  detected_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface EmailConfig {
  apiUrl: string;
  apiKey: string;
  to: string[];
  from: string;
}

export interface Email {
  subject: string;
  text: string;
}

/** Email config from env; null means dry-run (log only). Never hard-codes an address. */
export function emailConfigFrom(get: (name: string) => string | undefined): EmailConfig | null {
  const apiKey = get('ALERT_EMAIL_API_KEY');
  const toRaw = get('ALERT_EMAIL_TO');
  const from = get('ALERT_EMAIL_FROM');
  if (!apiKey || !toRaw || !from) return null;
  const to = toRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (to.length === 0) return null;
  return {
    apiUrl: get('ALERT_EMAIL_API_URL') ?? 'https://api.resend.com/emails',
    apiKey,
    to,
    from,
  };
}

/** 0 -> "0s", 59 -> "59s", 240 -> "4m", 3725 -> "1h 2m", 90061 -> "1d 1h 1m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0s';
}

function fmtTime(iso: string): string {
  // Display in Asia/Jerusalem (storage stays UTC).
  return (
    new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour12: false }) +
    ' (Asia/Jerusalem)'
  );
}

export function buildEmail(n: HeartbeatNotification): Email {
  if (n.kind === 'down') {
    return {
      subject: `[Gateway] DOWN: worker ${n.worker_id} stopped sending heartbeats`,
      text: [
        `השרת לא מגיב: ה-worker ${n.worker_id} הפסיק לשלוח heartbeat.`,
        `Worker ${n.worker_id} has not sent a heartbeat since ${fmtTime(n.started_at)}.`,
        `Detected at ${fmtTime(n.detected_at)}.`,
        '',
        'Baileys accounts on this worker are offline; queued messages are kept and will be sent after recovery.',
        'You will get exactly one more e-mail when it recovers.',
      ].join('\n'),
    };
  }
  const duration = formatDuration(n.duration_seconds ?? 0);
  return {
    subject: `[Gateway] RECOVERED: worker ${n.worker_id} is back (down ${duration})`,
    text: [
      `השרת חזר לפעול. זמן השבתה: ${duration}.`,
      `Worker ${n.worker_id} is sending heartbeats again.`,
      `Down from ${fmtTime(n.started_at)} to ${n.ended_at ? fmtTime(n.ended_at) : 'unknown'} (${duration}).`,
    ].join('\n'),
  };
}

/** Resend-compatible request body. */
export function emailRequestBody(cfg: EmailConfig, email: Email): Record<string, unknown> {
  return { from: cfg.from, to: cfg.to, subject: email.subject, text: email.text };
}
