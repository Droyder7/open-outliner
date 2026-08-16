/**
 * Per-tab replica identity (ADR-0019).
 *
 * The replica id is the HLC tie-breaker (ADR-0009) AND the key of the server's
 * `replica_sync` ack ledger, so its scope must be exactly one editing context.
 * It is minted once per TAB (`sessionStorage`: survives a refresh, dies with
 * the tab) rather than per install (`localStorage`): two tabs of the same
 * install are two independent replicas — each has its own HLC clock and its
 * own ack row, so one tab syncing can never unblock GC for a sibling that is
 * still receiving its first state, and concurrent offline edits from two tabs
 * tie-break deterministically instead of colliding under one id.
 */

export const REPLICA_ID_KEY = 'oo:replicaId';

export function getOrCreateReplicaId(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  mint: () => string = () => crypto.randomUUID(),
): string {
  const existing = storage.getItem(REPLICA_ID_KEY);
  if (existing) return existing;
  const fresh = mint();
  storage.setItem(REPLICA_ID_KEY, fresh);
  return fresh;
}
