import { BufferJSON, proto, type AuthenticationCreds, type SignalDataSet } from 'baileys';
import type { WAMessageContent } from 'baileys';
import type { SessionCipher } from './crypto';
import {
  CREDS_RECORD,
  SENT_MESSAGE_RECORD_TYPE,
  SIGNAL_KEY_TYPES,
  type RecordBackend,
  type SealedRow,
  type SessionStore,
  type SignalKeyResult,
  type SignalKeyType,
} from './types';

const KNOWN_KEY_TYPES: ReadonlySet<string> = new Set(SIGNAL_KEY_TYPES);

export function serialize(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
}

export function deserialize<T>(bytes: Uint8Array): T {
  return JSON.parse(Buffer.from(bytes).toString('utf8'), BufferJSON.reviver) as T;
}

/**
 * SessionStore over any RecordBackend. Serialisation (BufferJSON) and sealing (crypto.ts) happen
 * here once, so both backends behave identically and never touch crypto themselves.
 */
export class EncryptedSessionStore implements SessionStore {
  readonly accountId: string;
  readonly #backend: RecordBackend;
  readonly #cipher: SessionCipher;

  constructor(accountId: string, backend: RecordBackend, cipher: SessionCipher) {
    if (!accountId || accountId.includes('|')) throw new Error('invalid accountId');
    this.accountId = accountId;
    this.#backend = backend;
    this.#cipher = cipher;
  }

  #seal(keyType: string, keyId: string, value: unknown): SealedRow {
    const sealed = this.#cipher.seal(
      { accountId: this.accountId, recordType: keyType, recordId: keyId },
      serialize(value),
    );
    return { keyType, keyId, ...sealed };
  }

  #open<T>(row: SealedRow): T {
    const plain = this.#cipher.open(
      { accountId: this.accountId, recordType: row.keyType, recordId: row.keyId },
      row,
    );
    return deserialize<T>(plain);
  }

  async loadCreds(): Promise<AuthenticationCreds | null> {
    const rows = await this.#backend.get(this.accountId, CREDS_RECORD.type, [CREDS_RECORD.id]);
    const row = rows[0];
    return row ? this.#open<AuthenticationCreds>(row) : null;
  }

  async saveCreds(creds: AuthenticationCreds): Promise<void> {
    await this.#backend.write(
      this.accountId,
      [this.#seal(CREDS_RECORD.type, CREDS_RECORD.id, creds)],
      [],
    );
  }

  async getKeys<T extends SignalKeyType>(
    type: T,
    ids: readonly string[],
  ): Promise<SignalKeyResult<T>> {
    const out: SignalKeyResult<T> = {};
    if (ids.length === 0) return out;
    const rows = await this.#backend.get(this.accountId, type, ids);
    for (const row of rows) {
      let value = this.#open<unknown>(row);
      if (type === 'app-state-sync-key' && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
      }
      out[row.keyId] = value as SignalKeyResult<T>[string];
    }
    return out;
  }

  async setKeys(data: SignalDataSet): Promise<void> {
    const upserts: SealedRow[] = [];
    const deletes: Array<{ keyType: string; keyId: string }> = [];
    for (const type of Object.keys(data)) {
      if (!KNOWN_KEY_TYPES.has(type)) throw new Error(`unknown signal key type: ${type}`);
      const entries = data[type as SignalKeyType];
      if (!entries) continue;
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) deletes.push({ keyType: type, keyId: id });
        else upserts.push(this.#seal(type, id, value));
      }
    }
    if (upserts.length === 0 && deletes.length === 0) return;
    await this.#backend.write(this.accountId, upserts, deletes);
  }

  async recordSentMessage(messageId: string, message: WAMessageContent): Promise<void> {
    await this.#backend.write(
      this.accountId,
      [this.#seal(SENT_MESSAGE_RECORD_TYPE, messageId, { m: message, at: Date.now() })],
      [],
    );
  }

  async getSentMessage(messageId: string): Promise<WAMessageContent | undefined> {
    const rows = await this.#backend.get(this.accountId, SENT_MESSAGE_RECORD_TYPE, [messageId]);
    const row = rows[0];
    if (!row) return undefined;
    const { m } = this.#open<{ m: WAMessageContent }>(row);
    return proto.Message.fromObject(m as Record<string, unknown>);
  }

  async clear(): Promise<void> {
    await this.#backend.deleteAccount(this.accountId);
  }

  async close(): Promise<void> {
    await this.#backend.close();
  }
}
