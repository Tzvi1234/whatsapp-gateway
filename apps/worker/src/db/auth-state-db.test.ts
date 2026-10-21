import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { initAuthCreds } from 'baileys';
import { SessionCipher, createSupabaseSessionStore } from '@htz/provider-baileys';
import {
  bytesToPgHex,
  createBaileysAuthStateDb,
  pgHexToBytes,
  type AuthStateTable,
  type RawAuthStateRow,
} from './auth-state-db';

const ORG = '00000000-0000-4000-8000-000000000001';
const ACC = '00000000-0000-4000-8000-0000000000a1';

/** Mimics PostgREST: stores bytea as `\x…` strings, upsert on the PK. */
class FakeTable implements AuthStateTable {
  rows = new Map<string, RawAuthStateRow>();
  #k = (a: string, t: string, i: string) => JSON.stringify([a, t, i]);
  async select(a: string, t: string, ids: readonly string[]) {
    return ids.flatMap((i) => {
      const r = this.rows.get(this.#k(a, t, i));
      return r ? [{ ...r }] : [];
    });
  }
  async upsert(rows: readonly RawAuthStateRow[]) {
    for (const r of rows) {
      if (!r.org_id) throw new Error('org_id not null');
      if (typeof r.ciphertext !== 'string' || !r.ciphertext.startsWith('\\x'))
        throw new Error('bytea must be hex');
      this.rows.set(this.#k(r.account_id, r.key_type, r.key_id), { ...r });
    }
  }
  async delete(a: string, t: string, ids: readonly string[]) {
    for (const i of ids) this.rows.delete(this.#k(a, t, i));
  }
  async deleteAccount(a: string) {
    for (const [k, r] of this.rows) if (r.account_id === a) this.rows.delete(k);
  }
}

describe('baileys_auth_state adapter', () => {
  it('converts bytea hex both ways', () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(bytesToPgHex(b)).toBe('\\x0001feff');
    expect([...pgHexToBytes('\\x0001feff')]).toEqual([0, 1, 254, 255]);
    expect(() => pgHexToBytes('AAEC')).toThrow();
    expect(() => pgHexToBytes('\\x0')).toThrow();
  });

  it('C12 round-trips creds and signal keys (incl. lid-mapping) through the encrypted store; ciphertext only at rest', async () => {
    const table = new FakeTable();
    const cipher = new SessionCipher({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
    const store = createSupabaseSessionStore({
      db: createBaileysAuthStateDb(table, ORG),
      accountId: ACC,
      cipher,
    });
    const creds = initAuthCreds();
    await store.saveCreds(creds);
    await store.setKeys({
      'lid-mapping': { '972559014410': '123456789012345' },
      'pre-key': { '1': creds.signedPreKey.keyPair },
    });
    const back = await store.loadCreds();
    expect(back?.registrationId).toBe(creds.registrationId);
    const lm = await store.getKeys('lid-mapping', ['972559014410']);
    expect(lm['972559014410']).toBe('123456789012345');
    for (const r of table.rows.values()) {
      expect(r.org_id).toBe(ORG);
      expect(Buffer.from(r.ciphertext.slice(2), 'hex').toString('utf8')).not.toContain(
        '972559014410',
      );
    }
    await store.setKeys({ 'lid-mapping': { '972559014410': null } });
    expect(await store.getKeys('lid-mapping', ['972559014410'])).toEqual({});
  });
});
