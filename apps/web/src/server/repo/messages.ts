import { isGatewayErrorCode, ok, type MessageStatus, type Result } from '@htz/core';
import type { MessageView } from '@htz/mcp';
import type { Db } from '../supabase';
import { isUuid, query } from '../db';
import type { StoredOutbound } from '../cloud';

export const MESSAGE_COLUMNS =
  'id, account_id, conversation_id, direction, kind, body, status, delivery_mode, provider_message_id, quoted_provider_id, error_code, idempotency_key, use_case, media_path, media_mime, template, created_at, sent_at, conversations(chat_jid)';

export interface MessageRow {
  id: string;
  account_id: string;
  conversation_id: string | null;
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  status: MessageStatus;
  delivery_mode: 'native' | 'fallback' | 'text' | null;
  provider_message_id: string | null;
  quoted_provider_id: string | null;
  error_code: string | null;
  idempotency_key: string | null;
  use_case: string | null;
  media_path: string | null;
  media_mime: string | null;
  template: unknown;
  created_at: string;
  sent_at: string | null;
  conversations: { chat_jid: string } | { chat_jid: string }[] | null;
}

export function chatOf(row: Pick<MessageRow, 'conversations'>): string {
  const c = row.conversations;
  if (!c) return '';
  return Array.isArray(c) ? (c[0]?.chat_jid ?? '') : c.chat_jid;
}

const OUT_KINDS = new Set(['text', 'media', 'template', 'reaction', 'interactive']);
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

export function toMessageView(row: MessageRow): MessageView {
  const kind: MessageView['kind'] = OUT_KINDS.has(row.kind)
    ? (row.kind as MessageView['kind'])
    : MEDIA_KINDS.has(row.kind)
      ? 'media'
      : row.kind === 'interactive_reply'
        ? 'interactive'
        : 'unknown';
  const key = row.idempotency_key;
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    chat: chatOf(row),
    direction: row.direction,
    kind,
    text: row.body,
    status: row.status,
    deliveryMode: row.delivery_mode,
    providerMessageId: row.provider_message_id,
    replyToId: row.quoted_provider_id,
    errorCode: isGatewayErrorCode(row.error_code) ? row.error_code : null,
    clientMsgId: key && !key.startsWith('auto:') && !key.startsWith('dash:') ? key : null,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export async function getMessageRow(db: Db, id: string): Promise<Result<MessageRow | null>> {
  if (!isUuid(id)) return ok(null);
  return query<MessageRow | null>(
    db.from('messages').select(MESSAGE_COLUMNS).eq('id', id).maybeSingle(),
    'messages.get',
  );
}

/** Lookup by gateway id (uuid) or provider message id within one account. */
export async function findAccountMessage(
  db: Db,
  accountId: string,
  ref: string,
): Promise<Result<MessageRow | null>> {
  if (isUuid(ref)) {
    const r = await getMessageRow(db, ref);
    if (!r.ok) return r;
    return ok(r.value && r.value.account_id === accountId ? r.value : null);
  }
  return query<MessageRow | null>(
    db
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('account_id', accountId)
      .eq('provider_message_id', ref)
      .maybeSingle(),
    'messages.by_provider_id',
  );
}

export function toStoredOutbound(row: MessageRow): StoredOutbound {
  return {
    id: row.id,
    account_id: row.account_id,
    kind: row.kind,
    body: row.body,
    media_path: row.media_path,
    media_mime: row.media_mime,
    template: row.template,
    quoted_provider_id: row.quoted_provider_id,
    idempotency_key: row.idempotency_key,
    use_case: row.use_case,
    chat_jid: chatOf(row),
  };
}
