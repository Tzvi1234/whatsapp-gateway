import { normalizeJid, toE164 } from '@htz/core';

/** Known LID→PN mapping (Baileys `lid-mapping` / contacts table). Returns a PN JID or E.164, or null. */
export type LidToPnResolver = (lidJid: string) => string | null;

export interface InboundSender {
  senderPn: string | null;
  senderLid: string | null;
  fromMe: boolean;
  isGroup: boolean;
}

export type SenderMatch =
  | { allowed: true; e164: string; matchedVia: 'pn' | 'lid' }
  | { allowed: false; reason: 'from_me' | 'group' | 'unknown_sender' };

/** Normalise one allowlist entry or PN JID to E.164; null if unusable. */
export function toAllowlistE164(value: string): string | null {
  const v = value.trim();
  if (/^\+[1-9]\d{6,14}$/.test(v)) return v;
  if (v.includes('@')) {
    const j = normalizeJid(v);
    return j.ok && j.value.kind === 'pn' ? j.value.e164 : null;
  }
  const e = toE164(v);
  return e.ok ? e.value : null;
}

export function normalizeAllowlist(entries: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const n = toAllowlistE164(e);
    if (n) out.add(n);
  }
  return out;
}

/**
 * Sender guard for relay accounts (TEST-PLAN L1.1-L1.5). Matches the PN directly, or the LID
 * through the known mapping. Never matches the account's own messages or group traffic.
 * Unknown senders: caller logs `sender_unknown` and sends nothing.
 */
export function matchAllowedSender(
  sender: InboundSender,
  allowlist: readonly string[],
  resolveLidToPn: LidToPnResolver,
): SenderMatch {
  if (sender.fromMe) return { allowed: false, reason: 'from_me' };
  if (sender.isGroup) return { allowed: false, reason: 'group' };
  const allowed = normalizeAllowlist(allowlist);
  if (allowed.size === 0) return { allowed: false, reason: 'unknown_sender' };

  if (sender.senderPn) {
    const e = toAllowlistE164(sender.senderPn);
    if (e && allowed.has(e)) return { allowed: true, e164: e, matchedVia: 'pn' };
  }
  if (sender.senderLid) {
    const lid = normalizeJid(sender.senderLid);
    if (lid.ok && lid.value.kind === 'lid') {
      const mapped = resolveLidToPn(lid.value.jid);
      const e = mapped ? toAllowlistE164(mapped) : null;
      if (e && allowed.has(e)) return { allowed: true, e164: e, matchedVia: 'lid' };
    }
  }
  return { allowed: false, reason: 'unknown_sender' };
}
