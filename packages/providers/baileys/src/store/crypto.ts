/**
 * Encryption at rest for Baileys session material (ARCH §7.2, ADR-4, TEST-PLAN S4/C12).
 *
 * This is the ONLY module in the provider that touches `node:crypto` for session data.
 * Stores hand it plaintext bytes plus the record coordinates and get back sealed bytes.
 *
 *  - AES-256-GCM, random 96-bit nonce per record (never reused, even for identical values).
 *  - Per-account data key = HKDF-SHA256(master, salt, info = account_id). A row copied to
 *    another account therefore fails twice: wrong data key and wrong AAD.
 *  - AAD = `${account_id}|${record_type}|${record_id}` binds a ciphertext to its row.
 *  - The sealed blob starts with a one-byte key version (`[version][ct][tag]`) so a master key
 *    can be rotated: old rows keep decrypting with the old key, new writes use the current one.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';

export const MASTER_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const HKDF_SALT = Buffer.from('htz-whatsapp-gateway/baileys-session-store/v1', 'utf8');

export interface RecordRef {
  accountId: string;
  recordType: string;
  recordId: string;
}

/** What a store persists per row. Mirrors `baileys_auth_state(ciphertext, nonce, key_version)`. */
export interface SealedRecord {
  keyVersion: number;
  nonce: Uint8Array;
  /** `[keyVersion:1 byte][AES-GCM ciphertext][16-byte tag]` */
  ciphertext: Uint8Array;
}

export class SessionDecryptError extends Error {
  constructor(detail: string) {
    super(`session_decrypt_failed: ${detail}`);
    this.name = 'SessionDecryptError';
  }
}

export interface MasterKeyring {
  /** Version used for new writes (1..255). */
  currentVersion: number;
  /** All master keys still accepted for reading, by version. */
  keys: ReadonlyMap<number, Uint8Array>;
}

export function buildAad(ref: RecordRef): Buffer {
  for (const [k, v] of Object.entries(ref)) {
    if (typeof v !== 'string' || v.length === 0) throw new Error(`invalid record ref: ${k}`);
    if (k !== 'recordId' && v.includes('|')) throw new Error(`invalid record ref: ${k}`);
  }
  return Buffer.from(`${ref.accountId}|${ref.recordType}|${ref.recordId}`, 'utf8');
}

function assertVersion(v: number): void {
  if (!Number.isInteger(v) || v < 1 || v > 255) throw new Error('key version must be 1..255');
}

/** Seals/opens session records for any account with a keyring of master keys. */
export class SessionCipher {
  readonly #ring: MasterKeyring;
  readonly #dataKeys = new Map<string, Buffer>();

  constructor(ring: MasterKeyring) {
    assertVersion(ring.currentVersion);
    if (!ring.keys.has(ring.currentVersion)) throw new Error('current key version missing');
    for (const [v, k] of ring.keys) {
      assertVersion(v);
      if (k.byteLength !== MASTER_KEY_BYTES) throw new Error('master key must be 32 bytes');
    }
    // Defensive copies so callers can zero their buffers.
    const keys = new Map<number, Uint8Array>();
    for (const [v, k] of ring.keys) keys.set(v, Buffer.from(k));
    this.#ring = { currentVersion: ring.currentVersion, keys };
  }

  static fromMasterKey(master: Uint8Array, version = 1): SessionCipher {
    return new SessionCipher({ currentVersion: version, keys: new Map([[version, master]]) });
  }

  get currentVersion(): number {
    return this.#ring.currentVersion;
  }

  #dataKey(version: number, accountId: string): Buffer {
    const cacheKey = `${version}|${accountId}`;
    let k = this.#dataKeys.get(cacheKey);
    if (!k) {
      const master = this.#ring.keys.get(version);
      if (!master) throw new SessionDecryptError('unknown_key_version');
      k = Buffer.from(
        hkdfSync('sha256', master, HKDF_SALT, `account:${accountId}`, MASTER_KEY_BYTES),
      );
      this.#dataKeys.set(cacheKey, k);
    }
    return k;
  }

  seal(ref: RecordRef, plaintext: Uint8Array): SealedRecord {
    const aad = buildAad(ref);
    const version = this.#ring.currentVersion;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#dataKey(version, ref.accountId), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyVersion: version,
      nonce,
      ciphertext: Buffer.concat([Buffer.from([version]), body, tag]),
    };
  }

  open(ref: RecordRef, sealed: SealedRecord): Buffer {
    const aad = buildAad(ref);
    const ct = Buffer.from(sealed.ciphertext);
    const nonce = Buffer.from(sealed.nonce);
    if (ct.length < 1 + TAG_BYTES) throw new SessionDecryptError('ciphertext_too_short');
    if (nonce.length !== NONCE_BYTES) throw new SessionDecryptError('bad_nonce');
    const version = ct[0]!;
    if (version !== sealed.keyVersion) throw new SessionDecryptError('key_version_mismatch');
    const key = this.#dataKey(version, ref.accountId);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(ct.subarray(1, ct.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new SessionDecryptError('authentication_failed');
    }
  }

  /** True when the row was written with an older key and should be re-sealed. */
  needsRotation(sealed: SealedRecord): boolean {
    return sealed.keyVersion !== this.#ring.currentVersion;
  }
}

// ---------------------------------------------------------------------------------------------
// Master key loading (systemd LoadCredential aware)
// ---------------------------------------------------------------------------------------------

export interface MasterKeyLocation {
  /** Explicit path (e.g. SESSION_KEY_FILE). Wins over the credentials directory. */
  keyFile?: string | undefined;
  /** `$CREDENTIALS_DIRECTORY` set by systemd for `LoadCredential=`. */
  credentialsDirectory?: string | undefined;
  /** Credential name inside the credentials directory. Default `session.key`. */
  credentialName?: string;
}

export function resolveMasterKeyPath(loc: MasterKeyLocation): string {
  if (loc.keyFile) return loc.keyFile;
  if (loc.credentialsDirectory)
    return path.join(loc.credentialsDirectory, loc.credentialName ?? 'session.key');
  throw new Error('master key not configured: set SESSION_KEY_FILE or use LoadCredential');
}

/**
 * Reads the 32-byte master key. Refuses group/other-accessible files (anything looser than
 * 0600/0400), non-regular files and wrong sizes. Never logs or echoes key material.
 */
export async function loadMasterKey(loc: MasterKeyLocation | string): Promise<Buffer> {
  const file = typeof loc === 'string' ? loc : resolveMasterKeyPath(loc);
  const fh = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('master key: not a regular file');
    if ((st.mode & 0o077) !== 0)
      throw new Error(
        `master key: file mode ${(st.mode & 0o777).toString(8)} is too open (need 0600 or 0400)`,
      );
    if (st.size !== MASTER_KEY_BYTES)
      throw new Error(`master key: expected ${MASTER_KEY_BYTES} bytes, got ${st.size}`);
    const buf = Buffer.alloc(MASTER_KEY_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MASTER_KEY_BYTES, 0);
    if (bytesRead !== MASTER_KEY_BYTES) throw new Error('master key: short read');
    if (buf.every((b) => b === 0)) throw new Error('master key: all zero');
    return buf;
  } finally {
    await fh.close();
  }
}
