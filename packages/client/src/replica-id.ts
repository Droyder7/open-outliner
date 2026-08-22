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

/**
 * Per-tab replica id for the live app.
 *
 * sessionStorage itself can be unavailable — Safari with "block all cookies"
 * throws SecurityError on the property access — and a throw here would take the
 * whole editor down with it. Fall back to an in-memory id: cross-refresh
 * stability is lost (each page load is a fresh replica), which is GC-safe (the
 * server registers a blocking row per connect and the ack clears it) and only
 * weakens HLC tie-breaking across a refresh.
 *
 * Residual edge (accepted): "Duplicate Tab" copies sessionStorage, so the
 * duplicate starts with the SAME replica id as the original — two editing
 * contexts sharing one HLC clock and one `replica_sync` row. The GC hazard is
 * covered server-side (the in-process live-connection gate blocks the document
 * while either socket is unsynced); the HLC hazard degenerates to the
 * pre-ADR-0019 per-install behavior for those two tabs only.
 */
export function getOrCreateTabReplicaId(): string {
  try {
    return getOrCreateReplicaId(sessionStorage);
  } catch {
    return getOrCreateReplicaId(memoryFallback);
  }
}

// Module-scoped so the fallback id is stable for the page's lifetime.
const memoryFallback: Pick<Storage, 'getItem' | 'setItem'> = (() => {
  const memory = new Map<string, string>();
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
  };
})();
