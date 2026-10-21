/**
 * gateway-worker composition root (CODE-STRUCTURE §1): wiring only, no business logic.
 * htz-home-01, systemd --user, outbound connections only (Supabase REST/Realtime/Storage,
 * WhatsApp, the local transcriber socket).
 */
import { createClient } from '@supabase/supabase-js';
import { jidKind, normalizeJid } from '@htz/core';
import { createSendGate } from '@htz/policy';
import {
  BaileysProvider,
  BaileysSession,
  Pacer,
  SessionCipher,
  createLogger,
  createSupabaseSessionStore,
  loadMasterKey,
} from '@htz/provider-baileys';
import { ConfigError, loadConfig } from './config';
import { createBaileysAuthStateDb, supabaseAuthStateTable } from './db/auth-state-db';
import { supabaseChangeFeed } from './db/realtime';
import { createSupabaseWorkerDb } from './db/supabase-db';
import { createHeartbeat } from './heartbeat/heartbeat';
import { LogShipper } from './heartbeat/log-shipper';
import { supabaseMediaStore } from './inbound/media';
import { InboundPipeline, type InboundMessageEvent } from './inbound/pipeline';
import { RelayChannel } from './inbound/relay-channel';
import { StatusReplies } from './inbound/status-replies';
import { createOutbox } from './queue/outbox';
import { QueueProcessor } from './queue/processor';
import { createQueueRunner, type QueueRunner } from './queue/queue';
import { createAccountDirectory, type AccountContext } from './session/accounts';
import { SessionManager } from './session/manager';
import { createShutdown } from './shutdown';
import { createTranscriber } from './transcribe/transcriber';
import { WakeLoop } from './util/wake-loop';

declare const __WORKER_VERSION__: string | undefined;
declare const __BAILEYS_VERSION__: string | undefined;

const EXIT_CONFIG = 78; // EX_CONFIG: systemd RestartPreventExitStatus

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[gateway-worker] refusing to start: ${err.issues.join('; ')}\n`);
      process.exit(EXIT_CONFIG);
    }
    throw err;
  }

  const masterKey = await loadMasterKey(cfg.sessionKey).catch((err: Error) => {
    process.stderr.write(`[gateway-worker] refusing to start: ${err.message}\n`);
    process.exit(EXIT_CONFIG);
  });
  const cipher = new SessionCipher({ currentVersion: 1, keys: new Map([[1, masterKey]]) });
  masterKey.fill(0);

  const client = createClient(cfg.supabaseUrl, cfg.apiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${cfg.workerJwt}` } },
  });
  client.realtime.setAuth(cfg.workerJwt);
  const db = createSupabaseWorkerDb(client);

  const shipper = new LogShipper({
    db,
    orgId: cfg.orgId,
    workerId: cfg.workerId,
    minLevel: cfg.logShipLevel,
  });
  const log = createLogger({
    level: cfg.logLevel,
    base: { svc: 'gateway-worker', worker: cfg.workerId },
    destination: shipper,
  });
  const version = typeof __WORKER_VERSION__ === 'string' ? __WORKER_VERSION__ : cfg.version;
  const baileysVersion = typeof __BAILEYS_VERSION__ === 'string' ? __BAILEYS_VERSION__ : 'unknown';
  if (cfg.sonioxMisconfigured) log.warn({}, 'soniox_enabled_without_key_ignored');
  log.info(
    { version, baileysVersion, soniox: cfg.soniox !== null, seedSize: cfg.liaAllowlistSeed.length },
    'worker_boot',
  );

  const authDb = createBaileysAuthStateDb(supabaseAuthStateTable(client), cfg.orgId);
  const media = supabaseMediaStore(client, cfg.storageBucket);
  const feed = supabaseChangeFeed(client, {
    orgId: cfg.orgId,
    onStatus: (table, status) => log.info({ table, status }, 'realtime_status'),
  });
  const accounts = createAccountDirectory(db, { seed: cfg.liaAllowlistSeed });
  const gate = createSendGate({
    onCheck: (c) => {
      if (!c.allowed) log.warn({ entry: c.entryPoint, code: c.code }, 'send_gate_denied');
    },
  });
  const provider = new BaileysProvider({
    pacer: null, // pacing runs in the queue processor (wait with lease renewals, or reschedule)
    typingIndicator: false,
    resolveMedia: async (m) => Buffer.from(await media.download(m.storagePath)),
    logger: log,
  });
  const transcriber = createTranscriber(cfg);

  let queue: QueueRunner | null = null;
  const outbox = createOutbox({ db, wake: () => void queue?.wake(), log });

  const sessions: SessionManager = new SessionManager({
    orgId: cfg.orgId,
    workerId: cfg.workerId,
    db,
    createSession: (accountId, pairing) =>
      new BaileysSession({
        accountId,
        store: createSupabaseSessionStore({ db: authDb, accountId, cipher }),
        pairing,
        logger: log,
      }),
    provider,
    onMessage: (e) => enqueueInbound(e),
    onOpen: (accountId) => void recoverRelay(accountId),
    log,
  });

  // ---- inbound
  const relayChannels = new Map<string, RelayChannel>();
  const relayFor = (ctx: AccountContext): RelayChannel | null => {
    if (!ctx.relayTarget) return null;
    let ch = relayChannels.get(ctx.account.id);
    if (!ch) {
      const accountId = ctx.account.id;
      ch = new RelayChannel({
        accountId,
        relayTargetId: ctx.relayTarget.id,
        debounceMs: ctx.relayTarget.debounce_ms,
        db,
        session: () => sessions.session(accountId),
        outbox,
        transcriber,
        media,
        log: log.child({ mod: 'relay' }),
      });
      relayChannels.set(accountId, ch);
    }
    return ch;
  };
  const recovered = new Set<string>();
  const recoverRelay = async (accountId: string) => {
    if (recovered.has(accountId)) return;
    recovered.add(accountId);
    const ctx = await accounts.get(accountId).catch(() => null);
    const ch = ctx ? relayFor(ctx) : null;
    if (ch)
      await ch
        .recover()
        .catch((err: Error) => log.error({ err: err.name }, 'relay_recover_failed'));
  };
  const statusReplies = new StatusReplies({
    db,
    outbox,
    session: (id) => sessions.session(id),
    log: log.child({ mod: 'status' }),
  });
  const pipeline = new InboundPipeline({
    orgId: cfg.orgId,
    workerId: cfg.workerId,
    db,
    accounts,
    media,
    relay: relayFor,
    statusReplies,
    session: (id) => sessions.session(id),
    log: log.child({ mod: 'inbound' }),
  });
  const inboundChains = new Map<string, Promise<unknown>>();
  const enqueueInbound = (e: InboundMessageEvent) => {
    // Per-account order preserved; accounts independent.
    const prev = inboundChains.get(e.accountId) ?? Promise.resolve();
    const next = prev
      .then(() => pipeline.handle(e))
      .catch((err: Error) =>
        log.error({ err: err.name, detail: err.message?.slice(0, 120) }, 'inbound_failed'),
      );
    inboundChains.set(e.accountId, next);
  };

  // ---- queue
  const processor = new QueueProcessor({
    db,
    gate,
    provider,
    accounts,
    sessionState: (id) => sessions.state(id),
    resolveChatE164: async (accountId, chat) => {
      if (jidKind(chat) !== 'lid') return null;
      const pn = await sessions.session(accountId)?.pnForLid(chat);
      const n = pn ? normalizeJid(pn) : null;
      return n?.ok ? n.value.e164 : null;
    },
    pacer: new Pacer(),
    workerId: cfg.workerId,
    orgId: cfg.orgId,
    log: log.child({ mod: 'queue' }),
  });
  queue = createQueueRunner({
    processor,
    feed,
    pollIntervalMs: cfg.pollIntervalMs,
    onError: (err) => log.error({ err: (err as Error).name }, 'queue_pass_failed'),
  });

  // ---- loops
  const commands = new WakeLoop(() => sessions.syncCommands(), {
    intervalMs: cfg.pollIntervalMs,
    onError: (err) => log.error({ err: (err as Error).name }, 'commands_pass_failed'),
  });
  const locks = new WakeLoop(() => sessions.renewLocks(), {
    intervalMs: 25_000, // ≤30 s with a 90 s lease (database.md worker_try_lock_account)
    onError: (err) => log.error({ err: (err as Error).name }, 'lock_renew_failed'),
  });
  const heartbeat = createHeartbeat({
    db,
    orgId: cfg.orgId,
    workerId: cfg.workerId,
    version,
    baileysVersion,
    sockets: () => sessions.sockets(),
    log,
  });
  const logFlush = setInterval(() => void shipper.flush(), 5_000);
  const unsubs = [
    feed.onInsert('session_commands', () => void commands.wake()),
    feed.onInsert('pairing_requests', () => void commands.wake()),
  ];

  // Supabase may be unreachable at boot (home ISP): retry instead of crash-looping.
  let booted = false;
  void (async () => {
    for (let i = 0; !booted; i++) {
      try {
        await sessions.start();
        booted = true;
      } catch (err) {
        log.error({ err: (err as Error).name, attempt: i + 1 }, 'session_boot_failed');
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** i)));
      }
    }
  })();
  locks.start();
  commands.start();
  queue.start();
  heartbeat.start();
  log.info({ pollMs: cfg.pollIntervalMs }, 'worker_ready');

  const shutdown = createShutdown(
    [
      { name: 'queue', run: () => queue!.stop(), timeoutMs: 30_000 },
      { name: 'commands', run: () => commands.stop() },
      {
        name: 'relay',
        run: async () => {
          for (const ch of relayChannels.values()) ch.dispose(); // pending stays in DB (L3.3)
        },
      },
      {
        name: 'inbound',
        run: async () => void (await Promise.allSettled([...inboundChains.values()])),
      },
      { name: 'sessions', run: () => sessions.stop(), timeoutMs: 15_000 },
      { name: 'locks', run: () => locks.stop() },
      { name: 'heartbeat', run: () => heartbeat.stop() },
      {
        name: 'realtime',
        run: async () => void (await Promise.allSettled(unsubs.map((u) => u()))),
      },
      {
        name: 'logs',
        run: async () => {
          clearInterval(logFlush);
          for (let i = 0; i < 10 && shipper.pending > 0; i++) if (!(await shipper.flush())) break;
        },
        timeoutMs: 5_000,
      },
    ],
    log,
  );
  const onSignal = (sig: string) => () => void shutdown(sig).then(() => process.exit(0));
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('unhandledRejection', (err) =>
    log.error({ err: (err as Error)?.name ?? 'unknown' }, 'unhandled_rejection'),
  );
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.name }, 'uncaught_exception');
    void shutdown('uncaught_exception').then(() => process.exit(1));
  });
}

main().catch((err: Error) => {
  process.stderr.write(`[gateway-worker] fatal: ${err.name}: ${err.message?.slice(0, 200)}\n`);
  process.exit(1);
});
