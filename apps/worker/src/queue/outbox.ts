/**
 * Replies the worker originates itself (relay system replies, status-automation replies). They are
 * never sent directly: they are enqueued with `enqueue_message` so they get a `messages` row, the
 * retry/dead-letter semantics, and go through the same send gate as every other job (S13).
 */
import type { DeliveryMode } from '@htz/core';
import type { Logger } from 'pino';
import type { WorkerDb } from '../db/types';
import { RELAY_SYSTEM_KEY_PREFIX, STATUS_REPLY_KEY_PREFIX } from './processor';

export interface StatusReplyContent {
  text: string;
  media: { storagePath: string; mime: string } | null;
  deliveryMode: DeliveryMode;
}

export interface Outbox {
  /** Gateway-authored reply on a relay account (entry point `relay.system_reply`). */
  systemReply(
    accountId: string,
    chatJid: string,
    text: string,
    key: string,
  ): Promise<string | null>;
  /** Status-automation reply (entry point `automations.status_reply`). */
  statusReply(
    accountId: string,
    chatJid: string,
    reply: StatusReplyContent,
    key: string,
  ): Promise<string | null>;
}

export function createOutbox(deps: {
  db: Pick<WorkerDb, 'enqueueMessage'>;
  /** Wake the local queue so the reply goes out without waiting for Realtime/poll. */
  wake: () => void;
  log: Logger;
}): Outbox {
  const enqueue = async (
    args: Parameters<WorkerDb['enqueueMessage']>[0],
    what: string,
  ): Promise<string | null> => {
    try {
      const r = await deps.db.enqueueMessage({ ...args, p_executor: 'worker' });
      deps.wake();
      return r.message_id;
    } catch (err) {
      deps.log.error({ what, err: (err as Error).name }, 'enqueue_failed');
      return null;
    }
  };
  return {
    systemReply: (accountId, chatJid, text, key) =>
      enqueue(
        {
          p_account_id: accountId,
          p_chat_jid: chatJid,
          p_kind: 'text',
          p_body: text,
          p_use_case: 'agent_relay',
          p_idempotency_key: `${RELAY_SYSTEM_KEY_PREFIX}${key}`,
          p_delivery_mode: 'text',
        },
        'relay_system_reply',
      ),
    statusReply: (accountId, chatJid, reply, key) =>
      enqueue(
        reply.media
          ? {
              p_account_id: accountId,
              p_chat_jid: chatJid,
              p_kind: 'media',
              p_body: reply.text || null,
              p_media_path: reply.media.storagePath,
              p_media_mime: reply.media.mime,
              p_use_case: 'status_automation',
              p_idempotency_key: `${STATUS_REPLY_KEY_PREFIX}${key}`,
              p_delivery_mode: 'native',
            }
          : {
              p_account_id: accountId,
              p_chat_jid: chatJid,
              p_kind: 'text',
              p_body: reply.text,
              p_use_case: 'status_automation',
              p_idempotency_key: `${STATUS_REPLY_KEY_PREFIX}${key}`,
              p_delivery_mode: reply.deliveryMode,
            },
        'status_reply',
      ),
  };
}
