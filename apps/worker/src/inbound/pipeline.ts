/**
 * Inbound pipeline for Baileys `message` events (ARCH §4.4, §4.7; CODE-STRUCTURE: normalize →
 * sender-guard → debouncer → transcriber → relay enqueue).
 *
 * status broadcast (own posts → worker_upsert_status; others' statuses dropped) → contact upsert
 * (PN↔LID) → sender guard (relay accounts) → media to Storage → `ingest_inbound` (idempotent;
 * duplicates stop here) → route: relay channel | status-reply automations.
 */
import type { InboundEvent, Presence } from '@htz/core';
import { matchAllowedSender, type SenderMatch } from '@htz/policy';
import { hashId } from '@htz/provider-baileys';
import { routeInboundType } from '@htz/relay';
import type { Logger } from 'pino';
import type { WorkerDb } from '../db/types';
import type { AccountContext, AccountDirectory } from '../session/accounts';
import { mediaObjectPath, type MediaStore } from './media';
import type { RelayChannel } from './relay-channel';
import type { StatusReplies } from './status-replies';

/** What the pipeline needs from the live session (BaileysSession satisfies it). */
export interface PipelineSession {
  markRead(chat: string, ids: readonly string[]): Promise<void>;
  presence(chat: string, p: Presence): Promise<void>;
  pnForLid(lid: string): Promise<string | null>;
  lidForPn(pn: string): Promise<string | null>;
  downloadMedia(raw: never): Promise<Buffer>;
}

export interface InboundMessageEvent {
  accountId: string;
  event: InboundEvent;
  upsertType: 'notify' | 'append';
  /** Raw WAMessage (content!) — only handed to downloadMedia, never logged. */
  raw: unknown;
}

export interface InboundPipelineDeps {
  orgId: string;
  workerId: string;
  db: Pick<WorkerDb, 'upsertContact' | 'ingestInbound' | 'upsertStatus' | 'auditAppend'>;
  accounts: AccountDirectory;
  media: MediaStore;
  /** Relay channel for a relay account (created on demand by the composition root). */
  relay: (ctx: AccountContext) => RelayChannel | null;
  statusReplies: StatusReplies | null;
  session: (accountId: string) => PipelineSession | null;
  log: Logger;
}

const STORED_MEDIA: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'voice', 'document']);

export type InboundOutcome =
  | 'no_account'
  | 'status_posted'
  | 'status_ignored'
  | 'own_echo'
  | 'duplicate'
  | 'relay_accepted'
  | 'relay_unsupported'
  | 'relay_ignored'
  | 'sender_unknown'
  | 'from_me'
  | 'group'
  | 'status_reply'
  | 'stored';

export class InboundPipeline {
  readonly #d: InboundPipelineDeps;
  constructor(deps: InboundPipelineDeps) {
    this.#d = deps;
  }

  async handle(e: InboundMessageEvent): Promise<InboundOutcome> {
    const d = this.#d;
    const ev = e.event;
    const ctx = await d.accounts.get(e.accountId);
    if (!ctx) return 'no_account';
    const accountId = ctx.account.id;
    const log = d.log.child({ account: hashId(accountId) });
    const session = d.session(accountId);

    // ---- status@broadcast: own posts bind "next status" automations; others' are dropped.
    if (ev.chat === 'status@broadcast') {
      if (!ev.fromMe) return 'status_ignored';
      await d.db.upsertStatus(
        accountId,
        ev.providerMessageId,
        ev.type,
        ev.text,
        null,
        ev.timestamp,
      );
      log.info({}, 'status_posted');
      return 'status_posted';
    }

    // Echo of a message this socket just sent (Baileys emits own sends as `append`). The queue
    // records it via complete_job; ingesting it here would race that row (RL2).
    if (ev.fromMe && e.upsertType === 'append') return 'own_echo';

    // ---- identities (PN ↔ LID)
    let pn = ev.senderPn;
    const lid = ev.senderLid;
    if (!pn && lid && session) pn = await session.pnForLid(lid).catch(() => null);
    if (!ev.fromMe && !ev.isGroup && (pn || lid)) {
      await d.db
        .upsertContact(accountId, pn, lid, ev.pushName)
        .catch((err: Error) => log.warn({ err: err.name }, 'contact_upsert_failed'));
    }

    // ---- sender guard (relay accounts, L1.1-L1.5)
    let match: SenderMatch | null = null;
    let relayState: 'pending' | 'skipped' | null = null;
    const relayRoute = routeInboundType(ev.type);
    if (ctx.isRelay) {
      const resolved = pn;
      match = matchAllowedSender(
        { senderPn: ev.senderPn, senderLid: lid, fromMe: ev.fromMe, isGroup: ev.isGroup },
        ctx.relayAllowlist,
        (lidJid) => (lid && lidJid === lid ? resolved : null),
      );
      if (match.allowed) relayState = 'relay' in relayRoute ? 'pending' : 'skipped';
      else if (match.reason === 'unknown_sender') relayState = 'skipped';
    }

    // ---- media → private Storage (never for unknown senders on relay accounts: minimisation)
    let mediaPath: string | null = null;
    let audio: { bytes: Uint8Array; mime: string } | null = null;
    const wantMedia =
      ev.media !== null &&
      STORED_MEDIA.has(ev.type) &&
      session !== null &&
      (!ctx.isRelay || match?.allowed === true);
    if (wantMedia && ev.media) {
      try {
        const bytes = await session!.downloadMedia(e.raw as never);
        const path = mediaObjectPath(d.orgId, accountId, ev.providerMessageId);
        await d.media.upload(path, bytes, ev.media.mime);
        mediaPath = path;
        if (ev.type === 'voice') audio = { bytes: new Uint8Array(bytes), mime: ev.media.mime };
      } catch (err) {
        log.warn({ err: (err as Error).message?.slice(0, 80) }, 'media_store_failed');
      }
    }

    // ---- ingest (idempotent on (account, provider_message_id))
    const ing = await d.db.ingestInbound({
      p_account_id: accountId,
      p_provider_message_id: ev.providerMessageId,
      p_chat_jid: ev.chat,
      p_kind: ev.type,
      p_body: ev.text,
      p_sender_jid: pn ?? lid,
      p_from_me: ev.fromMe,
      p_push_name: ev.pushName,
      p_received_at: ev.timestamp,
      p_is_forwarded: ev.isForwarded,
      p_quoted_provider_id: ev.quotedProviderId,
      p_media_path: mediaPath,
      p_media_mime: ev.media?.mime ?? null,
      p_media_seconds: ev.media?.seconds ?? null,
      p_relay_state: relayState,
      p_raw: {
        type: ev.type,
        upsert: e.upsertType,
        forwarded: ev.isForwarded,
        has_media: ev.media !== null,
      },
      p_source: 'baileys',
      p_chat_type: ev.isGroup ? 'group' : 'direct',
    });
    if (!ing.created) return 'duplicate';

    // ---- route
    if (ctx.isRelay && match) {
      if (!match.allowed) {
        if (match.reason === 'from_me') return 'from_me'; // L1.4: never wakes Lia
        if (match.reason === 'group') return 'group'; // L1.5
        // L1.3 / L1.8: no reply at all, nothing to Lia, visible in the dashboard via audit/logs.
        log.warn(
          { correlation_id: ing.message_id, sender: hashId(pn ?? lid ?? 'none') },
          'sender_unknown',
        );
        await d.db
          .auditAppend(d.orgId, d.workerId, 'relay.sender_unknown', `account:${accountId}`, {
            message_id: ing.message_id,
            sender_hash: hashId(pn ?? lid ?? 'none'),
            type: ev.type,
          })
          .catch(() => undefined);
        return 'sender_unknown';
      }
      const channel = d.relay(ctx);
      if (!channel) return 'stored';
      channel.accept({
        messageId: ing.message_id,
        providerMessageId: ev.providerMessageId,
        conversationId: ing.conversation_id,
        chatJid: ev.chat,
        fromE164: match.e164,
        timestamp: ev.timestamp,
        type: ev.type,
        text: ev.text,
        replyToId: ev.quotedProviderId,
        isForwarded: ev.isForwarded,
        voiceSeconds: ev.media?.seconds ?? null,
        audio,
        mediaPath,
        mediaMime: ev.media?.mime ?? null,
      });
      if ('relay' in relayRoute) return 'relay_accepted';
      return 'unsupported' in relayRoute ? 'relay_unsupported' : 'relay_ignored';
    }

    if (
      ctx.statusAutomation &&
      d.statusReplies &&
      ev.statusReplyToId &&
      !ev.fromMe &&
      !ev.isGroup
    ) {
      await d.statusReplies.handle(ctx, { ...ev, senderPn: pn }, ing.message_id);
      return 'status_reply';
    }
    return 'stored';
  }
}
