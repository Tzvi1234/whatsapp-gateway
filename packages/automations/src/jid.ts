import { normalizeJid } from '@htz/core';

/** Known LID↔PN mapping (Baileys lid-mapping / contacts table). Both return JIDs or null. */
export interface LidPnResolver {
  lidToPn(lidJid: string): string | null;
  pnToLid(pnJid: string): string | null;
}

export const noopResolver: LidPnResolver = { lidToPn: () => null, pnToLid: () => null };

/**
 * Every identity key under which this contact may have been seen: `pn:+E164` and/or
 * `lid:<number>`, expanded through the resolver. Cooldowns are recorded under all of them
 * and checked against any of them, so the same person as LID and as PN collides (R2.2).
 */
export function contactKeys(
  senderPn: string | null | undefined,
  senderLid: string | null | undefined,
  resolver: LidPnResolver = noopResolver,
): string[] {
  const pns = new Set<string>();
  const lids = new Set<string>();
  const addPn = (v: string | null | undefined) => {
    if (!v) return;
    const j = normalizeJid(v);
    if (j.ok && j.value.kind === 'pn') pns.add(j.value.jid);
  };
  const addLid = (v: string | null | undefined) => {
    if (!v) return;
    const j = normalizeJid(v);
    if (j.ok && j.value.kind === 'lid') lids.add(j.value.jid);
  };
  addPn(senderPn);
  addLid(senderLid);
  for (const pn of [...pns]) addLid(resolver.pnToLid(pn));
  for (const lid of [...lids]) addPn(resolver.lidToPn(lid));

  const keys: string[] = [];
  for (const pn of pns) keys.push(`pn:+${pn.split('@')[0]}`);
  for (const lid of lids) keys.push(`lid:${lid.split('@')[0]}`);
  return keys.sort();
}

/** Cooldown key: one reply per contact per status per automation. */
export function cooldownKey(automationId: string, statusId: string, contactKey: string): string {
  return `${automationId}|${statusId}|${contactKey}`;
}
