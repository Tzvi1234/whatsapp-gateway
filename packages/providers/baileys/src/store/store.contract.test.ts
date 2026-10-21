/**
 * C12 / S4: one contract suite, run against every SessionStore backend.
 * Fictitious identifiers only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { initAuthCreds, proto, type AuthenticationCreds, type SignalDataSet } from 'baileys';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStoreAuthState } from '../auth-state';
import { SessionCipher, SessionDecryptError } from './crypto';
import { EncryptedSessionStore } from './encrypted-store';
import { SqliteRecordBackend } from './sqlite-store';
import { InMemoryBaileysAuthStateDb, SupabaseRecordBackend } from './supabase-store';
import { SIGNAL_KEY_TYPES, type RecordBackend, type SealedRow, type SessionStore } from './types';

const ACCOUNT_A = 'acc-test-a';
const ACCOUNT_B = 'acc-test-b';
const PN = '972500000001@s.whatsapp.net';
const LID = '123456789@lid';

interface Harness {
  /** Opens a store over the SAME underlying storage (simulates a process restart). */
  open(accountId: string, cipher: SessionCipher): SessionStore;
  raw(accountId: string): Promise<SealedRow[]>;
  putRaw(accountId: string, row: SealedRow): Promise<void>;
  dispose(): Promise<void>;
  fileMode?(): number;
  backendCalls?(): Array<{ op: string; n: number }>;
}

function sqliteHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-store-'));
  const file = path.join(dir, 'auth', 'session.sqlite');
  const backends: RecordBackend[] = [];
  const backend = () => {
    const b = new SqliteRecordBackend(file);
    backends.push(b);
    return b;
  };
  const inspector = backend() as SqliteRecordBackend;
  return {
    open: (accountId, cipher) => new EncryptedSessionStore(accountId, backend(), cipher),
    raw: async (accountId) =>
      inspector.rawRows(accountId).map((r) => ({
        keyType: r.key_type,
        keyId: r.key_id,
        keyVersion: r.key_version,
        nonce: r.nonce,
        ciphertext: r.ciphertext,
      })),
    putRaw: (accountId, row) => inspector.write(accountId, [row], []),
    dispose: async () => {
      for (const b of backends) await b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    fileMode: () => fs.statSync(file).mode & 0o777,
  };
}

function supabaseHarness(): Harness {
  const db = new InMemoryBaileysAuthStateDb();
  return {
    open: (accountId, cipher) =>
      new EncryptedSessionStore(accountId, new SupabaseRecordBackend(db), cipher),
    raw: async (accountId) =>
      [...db.rows.values()]
        .filter((r) => r.account_id === accountId)
        .map((r) => ({
          keyType: r.key_type,
          keyId: r.key_id,
          keyVersion: r.key_version,
          nonce: r.nonce,
          ciphertext: r.ciphertext,
        })),
    putRaw: (accountId, row) =>
      db.upsert([
        {
          account_id: accountId,
          key_type: row.keyType,
          key_id: row.keyId,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          key_version: row.keyVersion,
        },
      ]),
    dispose: async () => undefined,
    backendCalls: () => db.calls,
  };
}

function sampleKeys(): SignalDataSet {
  return {
    'pre-key': { '1': { public: randomBytes(32), private: randomBytes(32) } },
    session: { [`${LID.replace('@lid', '')}.0`]: randomBytes(64) },
    'sender-key': { '1203630@g.us::123456789::0': randomBytes(48) },
    'sender-key-memory': { '1203630@g.us': { [PN]: true } },
    'app-state-sync-key': {
      AAAAAQ: proto.Message.AppStateSyncKeyData.fromObject({
        keyData: randomBytes(32),
        fingerprint: { rawId: 7, currentIndex: 1, deviceIndexes: [0, 1] },
        timestamp: 1_700_000_000,
      }),
    },
    'app-state-sync-version': {
      regular: { version: 3, hash: randomBytes(128), indexValueMap: {} },
    },
    'lid-mapping': { '972500000001': '123456789', '123456789_reverse': '972500000001' },
    'device-list': { '972500000001': ['0', '12'] },
    tctoken: { [PN]: { token: randomBytes(16), timestamp: '1700000000' } },
    'identity-key': { '123456789.0': randomBytes(33) },
  };
}

function registeredCreds(): AuthenticationCreds {
  const c = initAuthCreds();
  c.registered = true;
  c.me = { id: '972500000001:3@s.whatsapp.net', lid: '123456789:3@lid', name: 'Test' };
  return c;
}

describe.each([
  ['sqlite-store', sqliteHarness],
  ['supabase-store', supabaseHarness],
] as const)('C12 SessionStore contract: %s', (_name, makeHarness) => {
  let h: Harness;
  let cipher: SessionCipher;

  beforeEach(() => {
    h = makeHarness();
    cipher = SessionCipher.fromMasterKey(randomBytes(32));
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('C12 creds round-trip and reopening restores the session', async () => {
    const creds = registeredCreds();
    await h.open(ACCOUNT_A, cipher).saveCreds(creds);

    const reopened = h.open(ACCOUNT_A, cipher);
    const loaded = await reopened.loadCreds();
    expect(loaded).not.toBeNull();
    expect(loaded!.me).toEqual(creds.me);
    expect(loaded!.registered).toBe(true);
    expect(Buffer.from(loaded!.noiseKey.private)).toEqual(Buffer.from(creds.noiseKey.private));
    expect(Buffer.from(loaded!.signedIdentityKey.public)).toEqual(
      Buffer.from(creds.signedIdentityKey.public),
    );

    const auth = await createStoreAuthState(reopened);
    expect(auth.restored).toBe(true);
    expect(auth.state.creds.registered).toBe(true);
  });

  it('C12 loadCreds is null for a never-paired account', async () => {
    expect(await h.open(ACCOUNT_A, cipher).loadCreds()).toBeNull();
    const auth = await createStoreAuthState(h.open(ACCOUNT_A, cipher));
    expect(auth.restored).toBe(false);
  });

  it('C12 every signal key type (incl. lid-mapping, device-list, tctoken) round-trips', async () => {
    const data = sampleKeys();
    expect(Object.keys(data).sort()).toEqual([...SIGNAL_KEY_TYPES].sort());
    await h.open(ACCOUNT_A, cipher).setKeys(data);

    const s = h.open(ACCOUNT_A, cipher);
    for (const type of SIGNAL_KEY_TYPES) {
      const expected = data[type]!;
      const got = await s.getKeys(type, Object.keys(expected));
      expect(Object.keys(got).sort()).toEqual(Object.keys(expected).sort());
      for (const [id, v] of Object.entries(expected)) {
        expect(JSON.parse(JSON.stringify(got[id]))).toEqual(JSON.parse(JSON.stringify(v)));
      }
    }
    const lid = await s.getKeys('lid-mapping', ['972500000001', '123456789_reverse']);
    expect(lid).toEqual({ '972500000001': '123456789', '123456789_reverse': '972500000001' });
    expect(await s.getKeys('device-list', ['972500000001'])).toEqual({
      '972500000001': ['0', '12'],
    });
    const tc = await s.getKeys('tctoken', [PN]);
    expect(Buffer.isBuffer(tc[PN]!.token)).toBe(true);
    const ask = await s.getKeys('app-state-sync-key', ['AAAAAQ']);
    expect(ask.AAAAAQ).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
  });

  it('C12 null deletes a key; unknown ids are simply absent', async () => {
    const s = h.open(ACCOUNT_A, cipher);
    await s.setKeys({ 'device-list': { a: ['0'], b: ['1'] } });
    await s.setKeys({ 'device-list': { a: null } });
    expect(await s.getKeys('device-list', ['a', 'b', 'zzz'])).toEqual({ b: ['1'] });
  });

  it('C12 getMessage returns own sent messages after restart and undefined for unknown ids', async () => {
    await h.open(ACCOUNT_A, cipher).recordSentMessage('3EB0AAAA', { conversation: 'probe' });
    const s = h.open(ACCOUNT_A, cipher);
    const m = await s.getSentMessage('3EB0AAAA');
    expect(m?.conversation).toBe('probe');
    expect(await s.getSentMessage('3EB0UNKNOWN')).toBeUndefined();
  });

  it('S4 rows hold ciphertext only (no plaintext JSON, no JIDs)', async () => {
    const s = h.open(ACCOUNT_A, cipher);
    await s.saveCreds(registeredCreds());
    await s.setKeys(sampleKeys());
    await s.recordSentMessage('3EB0AAAA', { conversation: 'secret body' });
    for (const r of await h.raw(ACCOUNT_A)) {
      const asText = Buffer.from(r.ciphertext).toString('latin1');
      expect(asText).not.toContain('972500000001');
      expect(asText).not.toContain('secret body');
      expect(asText).not.toContain('"type":"Buffer"');
    }
  });

  it('C12 wrong master key fails to decrypt', async () => {
    await h.open(ACCOUNT_A, cipher).saveCreds(registeredCreds());
    const other = SessionCipher.fromMasterKey(randomBytes(32));
    await expect(h.open(ACCOUNT_A, other).loadCreds()).rejects.toBeInstanceOf(SessionDecryptError);
  });

  it('C12 tampered ciphertext fails to decrypt', async () => {
    await h.open(ACCOUNT_A, cipher).saveCreds(registeredCreds());
    const [row] = await h.raw(ACCOUNT_A);
    const ct = Buffer.from(row!.ciphertext);
    ct[ct.length - 20]! ^= 0x01;
    await h.putRaw(ACCOUNT_A, { ...row!, ciphertext: ct });
    await expect(h.open(ACCOUNT_A, cipher).loadCreds()).rejects.toBeInstanceOf(SessionDecryptError);
  });

  it('S4 row copied to another account fails (AAD account_id|record_type|record_id)', async () => {
    await h.open(ACCOUNT_A, cipher).saveCreds(registeredCreds());
    const [row] = await h.raw(ACCOUNT_A);
    await h.putRaw(ACCOUNT_B, row!);
    await expect(h.open(ACCOUNT_B, cipher).loadCreds()).rejects.toBeInstanceOf(SessionDecryptError);
  });

  it('S4 row copied to another key id / type in the same account fails', async () => {
    const s = h.open(ACCOUNT_A, cipher);
    await s.setKeys({ 'device-list': { a: ['0'] } });
    const [row] = await h.raw(ACCOUNT_A);
    await h.putRaw(ACCOUNT_A, { ...row!, keyId: 'b' });
    await expect(s.getKeys('device-list', ['b'])).rejects.toBeInstanceOf(SessionDecryptError);
    await h.putRaw(ACCOUNT_A, { ...row!, keyType: 'lid-mapping' });
    await expect(s.getKeys('lid-mapping', ['a'])).rejects.toBeInstanceOf(SessionDecryptError);
  });

  it('C12 key version prefix present and rotation keeps old rows readable', async () => {
    const master1 = randomBytes(32);
    const v1 = SessionCipher.fromMasterKey(master1, 1);
    await h.open(ACCOUNT_A, v1).setKeys({ 'device-list': { old: ['0'] } });
    for (const r of await h.raw(ACCOUNT_A)) {
      expect(r.keyVersion).toBe(1);
      expect(Buffer.from(r.ciphertext)[0]).toBe(1);
    }
    const v2 = new SessionCipher({
      currentVersion: 2,
      keys: new Map([
        [1, master1],
        [2, randomBytes(32)],
      ]),
    });
    const s = h.open(ACCOUNT_A, v2);
    await s.setKeys({ 'device-list': { fresh: ['1'] } });
    expect(await s.getKeys('device-list', ['old', 'fresh'])).toEqual({
      old: ['0'],
      fresh: ['1'],
    });
    const fresh = (await h.raw(ACCOUNT_A)).find((r) => r.keyId === 'fresh')!;
    expect(fresh.keyVersion).toBe(2);
    expect(Buffer.from(fresh.ciphertext)[0]).toBe(2);
  });

  it('C12 the same value written twice gets different nonces and ciphertexts', async () => {
    const s = h.open(ACCOUNT_A, cipher);
    await s.setKeys({ 'device-list': { a: ['0'] } });
    const [first] = await h.raw(ACCOUNT_A);
    await s.setKeys({ 'device-list': { a: ['0'] } });
    const [second] = await h.raw(ACCOUNT_A);
    expect(Buffer.from(first!.nonce).equals(Buffer.from(second!.nonce))).toBe(false);
    expect(Buffer.from(first!.ciphertext).equals(Buffer.from(second!.ciphertext))).toBe(false);
    expect(first!.nonce.byteLength).toBe(12);
  });

  it('C12 clear() wipes only that account', async () => {
    await h.open(ACCOUNT_A, cipher).saveCreds(registeredCreds());
    await h.open(ACCOUNT_B, cipher).saveCreds(registeredCreds());
    await h.open(ACCOUNT_A, cipher).clear();
    expect(await h.raw(ACCOUNT_A)).toHaveLength(0);
    expect(await h.open(ACCOUNT_A, cipher).loadCreds()).toBeNull();
    expect(await h.open(ACCOUNT_B, cipher).loadCreds()).not.toBeNull();
  });

  it('C12 cached key store (makeCacheableSignalKeyStore) writes through', async () => {
    const auth = await createStoreAuthState(h.open(ACCOUNT_A, cipher));
    await auth.state.keys.set({ 'lid-mapping': { '972500000001': '123456789' } });
    const s = h.open(ACCOUNT_A, cipher);
    expect(await s.getKeys('lid-mapping', ['972500000001'])).toEqual({
      '972500000001': '123456789',
    });
  });

  it('rejects unknown key types', async () => {
    await expect(
      h.open(ACCOUNT_A, cipher).setKeys({ bogus: { a: 1 } } as unknown as SignalDataSet),
    ).rejects.toThrow(/unknown signal key type/);
  });

  if (makeHarness === sqliteHarness) {
    it('C11 session.sqlite is created with mode 0600', async () => {
      await h.open(ACCOUNT_A, cipher).saveCreds(registeredCreds());
      expect(h.fileMode!()).toBe(0o600);
    });
  }

  if (makeHarness === supabaseHarness) {
    it('ADR-4 keys.set is one batched upsert awaited before resolving', async () => {
      await h.open(ACCOUNT_A, cipher).setKeys({
        'pre-key': Object.fromEntries(
          Array.from({ length: 30 }, (_, i) => [
            String(i),
            { public: randomBytes(32), private: randomBytes(32) },
          ]),
        ),
        session: { x: null },
      });
      const calls = h.backendCalls!();
      expect(calls.filter((c) => c.op === 'upsert')).toEqual([{ op: 'upsert', n: 30 }]);
      expect(calls.filter((c) => c.op === 'delete')).toEqual([{ op: 'delete', n: 1 }]);
    });
  }
});

describe('C12 structure: stores never call crypto directly', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const src = path.resolve(dir, '..');
  const files = (d: string): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('only store/crypto.ts (session data) and log.ts (hashId) import node:crypto', () => {
    const importers = files(src)
      .filter((f) => /from\s+['"](node:)?crypto['"]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f))
      .sort();
    expect(importers).toEqual(['log.ts', path.join('store', 'crypto.ts')].sort());
  });

  it('store backends contain no cipher primitives', () => {
    for (const f of files(path.join(src, 'store')).filter((x) => !x.endsWith('crypto.ts'))) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/createCipheriv|createDecipheriv|randomBytes|hkdf/i);
    }
  });

  it('C13 useMultiFileAuthState is never used', () => {
    for (const f of files(src)) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/useMultiFileAuthState\s*\(/);
    }
  });
});
