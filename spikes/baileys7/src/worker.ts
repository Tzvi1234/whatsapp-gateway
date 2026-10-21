/**
 * Baileys 7 spike worker (task 0.3, ADR-5): terminal, pairing-code only, local encrypted SQLite
 * store, JSONL event log for the 72h baseline (RL6/RL8). No dashboard, no Supabase.
 *
 * Secrets: the pairing code is written ONLY to ${SPIKE_HOME}/pairing-code.txt (0600) and deleted
 * on connection open; it never reaches stdout, the journal or events.jsonl. JSONL has no message
 * content and only hashed ids.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BaileysSession,
  SessionCipher,
  createLogger,
  createSqliteSessionStore,
  loadMasterKey,
  type SessionEvent,
  type SessionStore,
} from '@htz/provider-baileys';
import { createEventLog } from './events';
import {
  EXIT_BAD_SESSION,
  EXIT_CONFIG,
  EXIT_CONFLICT,
  EXIT_LOGGED_OUT,
  EXIT_NUMBER_GUARD,
  EXIT_PAIRING_REQUIRED,
} from './exit-codes';
import { checkPairedIdentity, loadSpikeConfig } from './guard';
import { hashId, jidKind } from './hash';
import { assertNoteToSelf } from './probe';

function writeSecretFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'w' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  // Used by baileys-spike-restart.service (C14): mark the scheduled restart for the report.
  if (process.argv.includes('--mark-scheduled-restart')) {
    const home = process.env.SPIKE_HOME?.trim() || path.join(os.homedir(), 'baileys-spike');
    createEventLog(home).write({ type: 'scheduled_restart' });
    process.exit(0);
  }

  const cfgR = loadSpikeConfig(process.env, os.homedir());
  if (!cfgR.ok) {
    // Masked message only; never full numbers.
    process.stderr.write(`[baileys-spike] refusing to start: ${cfgR.error}\n`);
    process.exit(cfgR.exitCode);
  }
  const cfg = cfgR.value;
  const events = createEventLog(cfg.spikeHome);
  const pairingFile = path.join(cfg.spikeHome, 'pairing-code.txt');
  const log = createLogger({ level: cfg.logLevel, base: { svc: 'baileys-spike' } });
  const processStart = Date.now();
  events.write({ type: 'process_start', pid: process.pid, node: process.version });

  let store: SessionStore | null = null;
  let session: BaileysSession | null = null;
  let exiting = false;
  const timers: NodeJS.Timeout[] = [];

  const exit = async (code: number, reason: string): Promise<never> => {
    if (!exiting) {
      exiting = true;
      timers.forEach((t) => clearInterval(t));
      removeFile(pairingFile);
      events.write({ type: 'process_exit', exit_code: code, reason });
      log.info({ exitCode: code, reason }, 'exit');
      try {
        await session?.close();
      } catch {
        /* ignore */
      }
      try {
        await store?.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(code);
  };

  let key: Buffer;
  try {
    key = await loadMasterKey(cfg.keyLocation);
  } catch (e) {
    events.write({ type: 'config_error', detail: (e as Error).message.slice(0, 120) });
    process.stderr.write(`[baileys-spike] session key: ${(e as Error).message}\n`);
    return exit(EXIT_CONFIG, 'session_key');
  }

  const authDir = path.join(cfg.spikeHome, 'auth');
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(authDir, 0o700);
  store = createSqliteSessionStore({
    file: path.join(authDir, 'session.sqlite'),
    accountId: cfg.accountId,
    cipher: SessionCipher.fromMasterKey(key),
  });
  key.fill(0);

  const existing = await store.loadCreds();
  const hadCreds = Boolean(existing?.registered || existing?.me?.id);
  events.write({ type: 'store_opened', had_creds: hadCreds });

  session = new BaileysSession({
    accountId: cfg.accountId,
    store,
    pairing: { mode: 'code', phoneNumber: cfg.pairingE164 },
    logger: log,
    maxPairingAttempts: 3,
  });
  const s = session;

  let openedOnce = false;
  let restoreLogged = false;
  const pendingProbes = new Map<string, number>();
  let probeSeq = 0;

  const logRestore = (rePairNeeded: boolean, timeToOpenMs: number | null) => {
    if (!hadCreds || restoreLogged) return;
    restoreLogged = true;
    events.write({
      type: 'session_restored',
      re_pair_needed: rePairNeeded,
      time_to_open_ms: timeToOpenMs,
    });
  };

  const onEvent = async (e: SessionEvent): Promise<void> => {
    switch (e.type) {
      case 'connecting':
        events.write({ type: 'connecting', attempt: e.attempt, registered: e.registered });
        break;
      case 'pairing_code':
        writeSecretFile(pairingFile, `${e.code}\n`);
        events.write({ type: 'pairing_code_issued' });
        log.info({}, 'pairing code written to pairing-code.txt (0600)');
        break;
      case 'qr':
        // Not reachable in pairing-code mode; never persisted.
        break;
      case 'pairing_expired':
        events.write({ type: 'pairing_expired', attempts: e.attempts });
        if (hadCreds) logRestore(true, null);
        await exit(EXIT_PAIRING_REQUIRED, 'pairing_expired');
        break;
      case 'open': {
        removeFile(pairingFile);
        const id = await checkPairedIdentity(e.me, cfg.pairingE164, (lid) => s.pnForLid(lid));
        if (!id.ok) {
          events.write({ type: 'number_guard_mismatch', reason: id.reason });
          log.error({ reason: id.reason }, 'paired identity does not match PAIRING_NUMBER');
          try {
            await s.logout();
          } finally {
            await store?.clear().catch(() => undefined);
            await exit(EXIT_NUMBER_GUARD, 'number_guard_mismatch');
          }
          return;
        }
        if (e.isNewLogin) events.write({ type: 'paired', lid_verified: id.lidVerified });
        events.write({
          type: 'open',
          is_new_login: e.isNewLogin,
          restored: e.restored,
          since_start_ms: e.sinceStartMs,
          reconnect_ms: e.reconnectMs,
          lid_verified: id.lidVerified,
        });
        if (!openedOnce) logRestore(e.isNewLogin, e.isNewLogin ? null : Date.now() - processStart);
        openedOnce = true;
        break;
      }
      case 'relinked':
        break;
      case 'close':
        events.write({
          type: 'close',
          code: e.code,
          action: e.action,
          reconnect_in_ms: e.reconnectInMs,
        });
        break;
      case 'reconnecting':
        events.write({ type: 'reconnecting', attempt: e.attempt, delay_ms: e.delayMs });
        break;
      case 'needs_relink':
        events.write({ type: 'needs_relink', code: e.code, reason: e.reason });
        if (!openedOnce) logRestore(true, null);
        await exit(e.code === 401 ? EXIT_LOGGED_OUT : EXIT_BAD_SESSION, `needs_relink:${e.code}`);
        break;
      case 'conflict':
        events.write({ type: 'conflict', code: e.code });
        await exit(EXIT_CONFLICT, `conflict:${e.code}`);
        break;
      case 'decrypt_failure':
        events.write({
          type: 'decrypt_failure',
          chat_kind: e.chatKind,
          id_hash: hashId(e.providerMessageId),
        });
        break;
      case 'message':
        events.write({
          type: 'inbound',
          msg_type: e.event.type,
          upsert_type: e.upsertType,
          chat_kind: jidKind(e.event.chat),
          chat_hash: hashId(e.event.chat),
          from_me: e.event.fromMe,
          is_group: e.event.isGroup,
          has_media: e.event.media !== null,
          voice_seconds: e.event.type === 'voice' ? (e.event.media?.seconds ?? null) : undefined,
        });
        break;
      case 'status': {
        const id = e.update.providerMessageId;
        const sentAt = pendingProbes.get(id);
        events.write({ type: 'status', id_hash: hashId(id), status: e.update.status });
        if (sentAt !== undefined && e.update.status !== 'sending') {
          events.write({
            type: 'probe_ack',
            id_hash: hashId(id),
            status: e.update.status,
            ack_ms: Date.now() - sentAt,
          });
          if (e.update.status === 'delivered' || e.update.status === 'read')
            pendingProbes.delete(id);
        }
        break;
      }
      case 'store_error':
        events.write({ type: 'store_error', op: e.op, detail: e.detail });
        break;
    }
  };

  s.on((e) => {
    onEvent(e).catch((err: unknown) =>
      log.error({ err: (err as Error).name }, 'spike_event_handler_error'),
    );
  });

  // Heartbeat: lets the report bound uptime when the process dies without a close event.
  timers.push(
    setInterval(() => events.write({ type: 'heartbeat', state: s.state }), cfg.heartbeatSec * 1000),
  );

  // Optional note-to-self probe (only ever to our own JID) to measure send latency.
  if (cfg.probeIntervalMin > 0) {
    timers.push(
      setInterval(() => {
        if (s.state !== 'open' || !s.me) return;
        const self = s.me.pn ?? s.me.lid;
        if (!self) return;
        let target: string;
        try {
          target = assertNoteToSelf(self, self);
        } catch {
          events.write({ type: 'probe_refused' });
          return;
        }
        const seq = ++probeSeq;
        const t0 = Date.now();
        s.sendText(target, `spike probe #${seq} ${new Date(t0).toISOString()}`)
          .then(({ id }) => {
            pendingProbes.set(id, t0);
            events.write({
              type: 'send',
              kind: 'probe',
              ok: true,
              latency_ms: Date.now() - t0,
              id_hash: hashId(id),
            });
          })
          .catch((err: unknown) => {
            events.write({
              type: 'send',
              kind: 'probe',
              ok: false,
              latency_ms: Date.now() - t0,
              error: (err as Error).name,
            });
          });
      }, cfg.probeIntervalMin * 60_000),
    );
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void exit(0, sig);
    });
  }

  await s.start();
  log.info({ hadCreds, probeIntervalMin: cfg.probeIntervalMin }, 'spike started');
}

main().catch((err: unknown) => {
  process.stderr.write(`[baileys-spike] fatal: ${(err as Error).name}\n`);
  process.exit(1);
});
