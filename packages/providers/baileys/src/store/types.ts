import type {
  AuthenticationCreds,
  SignalDataSet,
  SignalDataTypeMap,
  WAMessageContent,
} from 'baileys';

/** Every signal key type Baileys 7.x persists through `SignalKeyStore`. */
export type SignalKeyType = keyof SignalDataTypeMap;

/**
 * Exhaustive list (compile-time checked against Baileys' `SignalDataTypeMap`): adding a key type
 * upstream breaks the build here instead of silently dropping it on restart.
 */
export const SIGNAL_KEY_TYPES = [
  'pre-key',
  'session',
  'sender-key',
  'sender-key-memory',
  'app-state-sync-key',
  'app-state-sync-version',
  'lid-mapping',
  'device-list',
  'tctoken',
  'identity-key',
] as const satisfies readonly SignalKeyType[];

type Missing = Exclude<SignalKeyType, (typeof SIGNAL_KEY_TYPES)[number]>;
const _exhaustive: [Missing] extends [never] ? true : Missing = true;
void _exhaustive;

/** Record types stored besides signal keys. */
export const CREDS_RECORD = { type: 'creds', id: 'creds' } as const;
export const SENT_MESSAGE_RECORD_TYPE = 'sent-message';

export type RecordType = SignalKeyType | typeof CREDS_RECORD.type | typeof SENT_MESSAGE_RECORD_TYPE;

export type SignalKeyResult<T extends SignalKeyType> = { [id: string]: SignalDataTypeMap[T] };

/**
 * Encrypted per-account Baileys session store (CODE-STRUCTURE §7, ADR-4).
 * One instance = one account. All values are serialised with Baileys `BufferJSON` and sealed by
 * `store/crypto.ts` before they reach the backend.
 */
export interface SessionStore {
  readonly accountId: string;
  /** `null` when the account was never paired (or was wiped). */
  loadCreds(): Promise<AuthenticationCreds | null>;
  saveCreds(creds: AuthenticationCreds): Promise<void>;
  getKeys<T extends SignalKeyType>(type: T, ids: readonly string[]): Promise<SignalKeyResult<T>>;
  /** Batched; resolves only after the whole batch is committed. `null` values delete. */
  setKeys(data: SignalDataSet): Promise<void>;
  /** Persist an outgoing message so `getMessage` can serve retry requests after a restart. */
  recordSentMessage(messageId: string, message: WAMessageContent): Promise<void>;
  /** The message this account sent with that id, or `undefined`. */
  getSentMessage(messageId: string): Promise<WAMessageContent | undefined>;
  /** Wipe everything for this account (logged out / bad session / spike teardown). */
  clear(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Backend: the only part that differs between SQLite and Supabase. Sees ciphertext only.
// ---------------------------------------------------------------------------------------------

export interface SealedRow {
  keyType: string;
  keyId: string;
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface RecordBackend {
  get(accountId: string, keyType: string, keyIds: readonly string[]): Promise<SealedRow[]>;
  /** Apply upserts and deletes for one account; must be committed before resolving. */
  write(
    accountId: string,
    upserts: readonly SealedRow[],
    deletes: ReadonlyArray<{ keyType: string; keyId: string }>,
  ): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;
  close(): Promise<void>;
}
