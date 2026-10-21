import 'server-only';
import {
  err,
  gatewayError,
  ok,
  type OutboundMessage,
  type Result,
  type SendResult,
} from '@htz/core';
import { CloudApiProvider, type CloudCredentials } from '@htz/provider-cloud';
import type { Db } from './supabase';
import { rpcRow } from './db';
import { isStoragePath, signedMediaUrl } from './media';

/**
 * Meta Cloud API on Vercel (ARCH §4.1). Credentials are read per call from Vault through
 * `provider_credentials_read` (service role); they never leave this module's callers.
 */

export interface StoredCloudCredentials {
  phoneNumberId: string | null;
  wabaId: string | null;
  accessToken: string | null;
  appSecret: string | null;
  verifyToken: string | null;
}

interface CredRow {
  phone_number_id: string | null;
  waba_id: string | null;
  access_token: string | null;
  app_secret: string | null;
  verify_token: string | null;
}

export async function readCloudCredentials(
  db: Db,
  accountId: string,
): Promise<Result<StoredCloudCredentials | null>> {
  const r = await rpcRow<CredRow>(db, 'provider_credentials_read', { p_account_id: accountId });
  if (!r.ok) return r;
  if (!r.value) return ok(null);
  return ok({
    phoneNumberId: r.value.phone_number_id,
    wabaId: r.value.waba_id,
    accessToken: r.value.access_token,
    appSecret: r.value.app_secret,
    verifyToken: r.value.verify_token,
  });
}

/** Builds a provider bound to this request's DB client. */
export function createCloudProvider(db: Db): CloudApiProvider {
  return new CloudApiProvider({
    credentials: async (accountId): Promise<CloudCredentials | null> => {
      const r = await readCloudCredentials(db, accountId);
      if (!r.ok) throw new Error('credentials_lookup_failed');
      const c = r.value;
      if (!c?.phoneNumberId || !c.accessToken) return null;
      return { phoneNumberId: c.phoneNumberId, accessToken: c.accessToken };
    },
    resolveMedia: async (_accountId, storagePath) => {
      if (/^https:\/\//i.test(storagePath)) return ok({ link: storagePath });
      if (!isStoragePath(storagePath)) return err(gatewayError('invalid_input', 'bad_media_path'));
      const url = await signedMediaUrl(db, storagePath);
      return url.ok ? ok({ link: url.value }) : url;
    },
  });
}

/** A stored outbound `messages` row (+ its conversation's chat) ready to send. */
export interface StoredOutbound {
  id: string;
  account_id: string;
  kind: string;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  template: unknown;
  quoted_provider_id: string | null;
  idempotency_key: string | null;
  use_case: string | null;
  chat_jid: string;
}

function parseTemplate(t: unknown): OutboundMessage['template'] | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.language !== 'string') return null;
  const params = Array.isArray(o.params) ? o.params.filter((p) => typeof p === 'string') : [];
  return { name: o.name, language: o.language, params: params as string[] };
}

/** Maps a stored row to the provider's `OutboundMessage`. */
export function toOutbound(m: StoredOutbound): Result<OutboundMessage> {
  const base = {
    accountId: m.account_id,
    to: m.chat_jid,
    idempotencyKey: m.idempotency_key ?? m.id,
    useCase: (m.use_case ?? 'notifications') as OutboundMessage['useCase'],
    ...(m.quoted_provider_id ? { quotedProviderId: m.quoted_provider_id } : {}),
  };
  switch (m.kind) {
    case 'text':
      if (!m.body) return err(gatewayError('invalid_input', 'missing_text'));
      return ok({ ...base, kind: 'text', text: m.body });
    case 'media': {
      if (!m.media_path || !m.media_mime)
        return err(gatewayError('invalid_input', 'missing_media'));
      const media: NonNullable<OutboundMessage['media']> = {
        storagePath: m.media_path,
        mime: m.media_mime,
      };
      if (m.body) media.caption = m.body;
      return ok({ ...base, kind: 'media', media });
    }
    case 'template': {
      const template = parseTemplate(m.template);
      if (!template) return err(gatewayError('invalid_input', 'missing_template'));
      return ok({ ...base, kind: 'template', template });
    }
    default:
      return err(gatewayError('capability_unsupported', `cloud_kind_${m.kind}`));
  }
}

export async function sendStored(
  provider: CloudApiProvider,
  m: StoredOutbound,
): Promise<SendResult> {
  const out = toOutbound(m);
  if (!out.ok) {
    const e: NonNullable<SendResult['error']> = { code: out.error.code, transient: false };
    if (out.error.detail) e.detail = out.error.detail;
    return { ok: false, error: e };
  }
  try {
    return await provider.send(out.value);
  } catch {
    return { ok: false, error: { code: 'internal', transient: true, detail: 'provider_threw' } };
  }
}
