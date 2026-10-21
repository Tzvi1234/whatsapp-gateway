/**
 * Realtime `postgres_changes` subscriptions used only as wake-up signals (ADR-2). Payloads are
 * never trusted for data: the handler re-reads through RPCs / selects. If a channel errors, the
 * WakeLoop poll keeps the worker correct (RL1).
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type WatchedTable = 'outbound_queue' | 'session_commands' | 'pairing_requests';

export interface ChangeFeed {
  /** Calls `onChange` on every INSERT into `table`. Returns an unsubscribe function. */
  onInsert(table: WatchedTable, onChange: () => void): () => Promise<void>;
}

export function supabaseChangeFeed(
  client: SupabaseClient,
  opts: { orgId: string; onStatus?: (table: WatchedTable, status: string) => void },
): ChangeFeed {
  return {
    onInsert(table, onChange) {
      const ch: RealtimeChannel = client
        .channel(`worker:${table}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table, filter: `org_id=eq.${opts.orgId}` },
          () => onChange(),
        )
        .subscribe((status) => opts.onStatus?.(table, String(status)));
      return async () => {
        await client.removeChannel(ch);
      };
    },
  };
}

/** No-op feed (tests, or when Realtime is disabled): polling alone still works. */
export const nullChangeFeed: ChangeFeed = {
  onInsert: () => async () => undefined,
};
