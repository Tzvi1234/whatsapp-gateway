import { createHash } from 'node:crypto';
import { pino, type Logger, type LoggerOptions } from 'pino';

/** Truncated sha256 for log-safe identifiers (never log full JIDs or phone numbers). */
export function hashId(value: string, len = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, len);
}

/**
 * Keys that may carry message content, QR payloads, pairing codes, phone numbers or JIDs —
 * both in our own log calls and in Baileys' internal ones.
 */
export const REDACT_PATHS = [
  'qr',
  'pairingCode',
  'text',
  'caption',
  'message',
  'msg',
  'messages',
  'content',
  'jid',
  'jids',
  'remoteJid',
  'remoteJidAlt',
  'participant',
  'participantAlt',
  'phoneNumber',
  'phone',
  'to',
  'from',
  'me',
  'user',
  'creds',
  'key',
  'keys',
  'node',
  'attrs',
  'fullMessage',
  'pushName',
  '*.qr',
  '*.text',
  '*.caption',
  '*.message',
  '*.jid',
  '*.remoteJid',
  '*.remoteJidAlt',
  '*.participant',
  '*.participantAlt',
  '*.to',
  '*.from',
  '*.id',
  '*.lid',
  '*.attrs',
  '*.pushName',
];

export interface CreateLoggerOptions {
  level?: LoggerOptions['level'];
  /** Base bindings (e.g. `{ account: hashId(accountId) }`). Never put raw JIDs here. */
  base?: Record<string, unknown>;
  destination?: pino.DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    // Log text goes to `event`, so `msg` objects (Baileys logs full WAMessages under it) can be
    // redacted without censoring our own log lines.
    messageKey: 'event',
    base: opts.base ?? null,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
