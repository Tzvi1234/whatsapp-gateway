/**
 * Minimal structured logger for Vercel logs. Redacts by default (CODE-STRUCTURE §3): any key
 * that looks like a secret or message content is dropped, and digit runs that look like phone
 * numbers are masked to their last 4 digits.
 */

const SECRET_KEY =
  /(secret|token|password|passwd|key|authorization|cookie|signature|body|text|qr|code_value)/i;

function maskString(s: string): string {
  return s.replace(/\+?\d{7,15}/g, (m) => `…${m.slice(-4)}`);
}

export function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY.test(k)) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string') {
      out[k] = maskString(v).slice(0, 300);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      out[k] = '[object]';
    }
  }
  return out;
}

function emit(level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>) {
  const line = JSON.stringify({ level, msg, ...redactMeta(meta), at: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const logInfo = (msg: string, meta: Record<string, unknown> = {}) => emit('info', msg, meta);
export const logWarn = (msg: string, meta: Record<string, unknown> = {}) => emit('warn', msg, meta);
export const logError = (msg: string, meta: Record<string, unknown> = {}) =>
  emit('error', msg, meta);
