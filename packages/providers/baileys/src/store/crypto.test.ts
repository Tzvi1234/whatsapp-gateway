import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAad,
  loadMasterKey,
  resolveMasterKeyPath,
  SessionCipher,
  SessionDecryptError,
} from './crypto';

const ref = { accountId: 'acc-1', recordType: 'session', recordId: '123456789.0' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function keyFile(name: string, mode: number, bytes: Buffer = randomBytes(32)): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes, { mode });
  fs.chmodSync(f, mode);
  return f;
}

describe('store/crypto', () => {
  it('S4 seal/open round-trips with AAD account|type|id', () => {
    const c = SessionCipher.fromMasterKey(randomBytes(32));
    const sealed = c.seal(ref, Buffer.from('hello'));
    expect(c.open(ref, sealed).toString()).toBe('hello');
    expect(buildAad(ref).toString()).toBe('acc-1|session|123456789.0');
  });

  it('S4 any AAD change fails', () => {
    const c = SessionCipher.fromMasterKey(randomBytes(32));
    const sealed = c.seal(ref, Buffer.from('hello'));
    for (const bad of [
      { ...ref, accountId: 'acc-2' },
      { ...ref, recordType: 'pre-key' },
      { ...ref, recordId: '123456789.1' },
    ]) {
      expect(() => c.open(bad, sealed)).toThrow(SessionDecryptError);
    }
  });

  it('S4 version byte must match the key_version column', () => {
    const c = SessionCipher.fromMasterKey(randomBytes(32));
    const sealed = c.seal(ref, Buffer.from('x'));
    expect(() => c.open(ref, { ...sealed, keyVersion: 2 })).toThrow(/key_version_mismatch/);
  });

  it('rejects bad key sizes and ids containing the separator', () => {
    expect(() => SessionCipher.fromMasterKey(randomBytes(16))).toThrow();
    const c = SessionCipher.fromMasterKey(randomBytes(32));
    expect(() => c.seal({ ...ref, accountId: 'a|b' }, Buffer.from('x'))).toThrow();
  });

  it('C12 loads a 0400/0600 32-byte key via explicit path or $CREDENTIALS_DIRECTORY', async () => {
    const f = keyFile('session.key', 0o400);
    expect((await loadMasterKey({ keyFile: f })).length).toBe(32);
    expect(resolveMasterKeyPath({ credentialsDirectory: dir })).toBe(f);
    expect((await loadMasterKey({ credentialsDirectory: dir })).length).toBe(32);
    const g = keyFile('k600', 0o600);
    expect((await loadMasterKey(g)).length).toBe(32);
  });

  it.each([0o640, 0o644, 0o604, 0o660])('S4 refuses key file mode %o', async (mode) => {
    const f = keyFile(`loose-${mode}`, mode);
    await expect(loadMasterKey(f)).rejects.toThrow(/too open/);
  });

  it('refuses wrong size, all-zero key and missing config', async () => {
    await expect(loadMasterKey(keyFile('short', 0o600, randomBytes(31)))).rejects.toThrow(
      /expected 32/,
    );
    await expect(loadMasterKey(keyFile('zero', 0o600, Buffer.alloc(32)))).rejects.toThrow(
      /all zero/,
    );
    expect(() => resolveMasterKeyPath({})).toThrow(/not configured/);
  });
});
