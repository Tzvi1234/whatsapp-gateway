import { jidNormalizedUser } from 'baileys';

/**
 * Note-to-self probe: target MUST equal the connected account's own JID.
 * Throws if the destination is anything else.
 */
export function assertNoteToSelf(targetJid: string, selfJid: string): string {
  const target = jidNormalizedUser(targetJid);
  const self = jidNormalizedUser(selfJid);
  if (!target || !self || target !== self) {
    throw new Error(`note_to_self_violation: target≠self`);
  }
  return target;
}
