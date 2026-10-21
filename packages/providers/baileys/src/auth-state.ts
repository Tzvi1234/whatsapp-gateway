import {
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type AuthenticationState,
  type SignalKeyStore,
  type SocketConfig,
} from 'baileys';
import type { SessionStore } from './store/types';

export interface StoreAuthState {
  state: AuthenticationState;
  /** true when creds were loaded from the store (i.e. not a fresh pairing). */
  restored: boolean;
  /** Persist `state.creds` (Baileys mutates it in place on `creds.update`). Serialised. */
  saveCreds(): Promise<void>;
}

/**
 * Builds the Baileys `AuthenticationState` from an encrypted SessionStore, wrapped in
 * `makeCacheableSignalKeyStore` (C13). `useMultiFileAuthState` is banned.
 */
export async function createStoreAuthState(
  store: SessionStore,
  logger?: SocketConfig['logger'],
): Promise<StoreAuthState> {
  const loaded = await store.loadCreds();
  const creds = loaded ?? initAuthCreds();

  const backing: SignalKeyStore = {
    get: (type, ids) => store.getKeys(type, ids),
    set: (data) => store.setKeys(data),
    clear: () => store.clear(),
  };

  let chain: Promise<void> = Promise.resolve();
  const saveCreds = (): Promise<void> => {
    const next = chain.then(() => store.saveCreds(creds));
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    state: { creds, keys: makeCacheableSignalKeyStore(backing, logger) },
    restored: loaded !== null,
    saveCreds,
  };
}
