'use server';

import { requireMemberAal2 } from '../auth';
import { serviceClient, userClient } from '../supabase';
import { mediaOriginalUrl, type MediaUrl } from '../media-access';
import { fail, GENERIC_HE, okResult, type ActionResult } from './result';

const MESSAGES_HE = {
  not_found: GENERIC_HE.not_found,
  media_purged: 'ההקלטה המקורית כבר לא שמורה (נמחקה אוטומטית אחרי 30 יום).',
  media_unavailable: 'ההקלטה המקורית עדיין לא זמינה. נסה שוב בעוד דקה.',
  internal: GENERIC_HE.internal,
} as const;

/**
 * "Play original" for a voice note (or any stored media) of a message (S9). Member + AAL2.
 * Returns a signed URL valid for at most 15 minutes; never cache it in the client.
 * After the retention purge returns `media_purged`.
 */
export async function getVoiceOriginalUrl(messageId: string): Promise<ActionResult<MediaUrl>> {
  const auth = await requireMemberAal2();
  if (!auth.ok) return auth;
  const r = await mediaOriginalUrl(await userClient(), serviceClient(), auth.data.orgId, messageId);
  if (!r.ok) return fail(r.error.code, MESSAGES_HE[r.error.code]);
  return okResult(r.value);
}
