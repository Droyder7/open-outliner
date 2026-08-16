import { REPLICA_SYNCED_PAYLOAD } from '@open-outliner/shared';

/**
 * ADR-0019 client sync-ack decision.
 *
 * The Hocuspocus provider reports `synced` when it completes an initial sync or
 * re-syncs after a reconnect — the exact moments this replica has received
 * every tombstone broadcast up to that point. The client acknowledges by
 * sending the stateless payload exactly then; on any other provider state it
 * sends nothing (a never-acked replica keeps its blocking `replica_sync` row,
 * which is what gates tombstone-aware GC server-side).
 *
 * Extracted from `session.ts` so the wire contract is unit-testable without a
 * browser, IndexedDB, or a live provider (see sync-ack.test.ts).
 */
export function syncAckPayload(synced: boolean): string | null {
  return synced ? REPLICA_SYNCED_PAYLOAD : null;
}
