import { toE164 } from './phone';
import { err, ok, type Result } from './result';
import { gatewayError, type GatewayError } from './errors';

export type JidKind = 'pn' | 'lid' | 'group' | 'status' | 'newsletter' | 'other';

export interface NormalizedJid {
  kind: JidKind;
  /** Canonical JID without device suffix, e.g. `972559014410@s.whatsapp.net`, `123@lid`. */
  jid: string;
  /** The user part, e.g. `972559014410` or the LID number. */
  user: string;
  /** E.164 when kind === 'pn'. */
  e164: string | null;
}

const PN_SERVERS = new Set(['s.whatsapp.net', 'c.us']);
const LID_SERVERS = new Set(['lid', 'hosted.lid']);

export function jidKind(jid: string | null | undefined): JidKind {
  if (!jid) return 'other';
  if (jid === 'status@broadcast') return 'status';
  const at = jid.lastIndexOf('@');
  if (at < 0) return 'other';
  const server = jid.slice(at + 1);
  if (PN_SERVERS.has(server) || server === 'hosted') return 'pn';
  if (LID_SERVERS.has(server)) return 'lid';
  if (server === 'g.us') return 'group';
  if (server === 'newsletter') return 'newsletter';
  return 'other';
}

/**
 * Normalise anything a caller may pass as a chat or sender: an E.164 / Israeli
 * local number, a PN JID (`@s.whatsapp.net` / `@c.us`, with or without `:device`),
 * a LID JID, or a group JID. Uses `toE164` as the single phone implementation.
 */
export function normalizeJid(input: string): Result<NormalizedJid, GatewayError> {
  const value = input.trim();
  if (!value.includes('@')) {
    const e = toE164(value);
    if (!e.ok) return e;
    const user = e.value.slice(1);
    return ok({ kind: 'pn', jid: `${user}@s.whatsapp.net`, user, e164: e.value });
  }

  const at = value.lastIndexOf('@');
  const server = value.slice(at + 1).toLowerCase();
  // strip device (":12") and agent ("_1") suffixes
  const userPart = value.slice(0, at).split(':')[0]!.split('_')[0]!;
  if (!userPart) return err(gatewayError('invalid_number', 'empty_jid_user'));

  if (PN_SERVERS.has(server)) {
    if (!/^\d{6,15}$/.test(userPart)) return err(gatewayError('invalid_number', 'bad_pn_jid'));
    return ok({
      kind: 'pn',
      jid: `${userPart}@s.whatsapp.net`,
      user: userPart,
      e164: `+${userPart}`,
    });
  }
  if (LID_SERVERS.has(server)) {
    if (!/^\d+$/.test(userPart)) return err(gatewayError('invalid_number', 'bad_lid_jid'));
    return ok({ kind: 'lid', jid: `${userPart}@lid`, user: userPart, e164: null });
  }
  if (server === 'g.us') {
    return ok({ kind: 'group', jid: `${userPart}@g.us`, user: userPart, e164: null });
  }
  if (value === 'status@broadcast') {
    return ok({ kind: 'status', jid: value, user: 'status', e164: null });
  }
  return err(gatewayError('invalid_number', 'unsupported_jid_server'));
}

/** E.164 -> PN JID. */
export function e164ToJid(e164: string): string {
  return `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
}
