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
 * The duplicate-tab edge (sessionStorage is COPIED on "Duplicate Tab") is
 * closed by `claimTabReplicaId` below, not accepted — see the ADR-0009 note
 * (2026-08-22).
 */
export function getOrCreateTabReplicaId(): string {
  return getOrCreateReplicaId(tabStorage());
}

// Module-scoped so the fallback id is stable for the page's lifetime.
const memoryFallback: Pick<Storage, 'getItem' | 'setItem'> = (() => {
  const memory = new Map<string, string>();
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
  };
})();

/** Resolve the tab's storage once, never throwing (see getOrCreateTabReplicaId). */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return sessionStorage;
  } catch {
    return memoryFallback;
  }
}

/**
 * The shareable half of a BroadcastChannel: enough to run the duplicate-tab
 * duel. Structurally satisfied by the browser's BroadcastChannel (messages are
 * plain strings; events are read through `.data`).
 */
export interface ReplicaClaimChannel {
  postMessage(data: string): void;
  close(): void;
  onmessage: ((event: { data: string }) => void) | null;
}

export interface ReplicaIdClaim {
  /** The currently-held id. Changes at most once per tab, on a lost duel. */
  get(): string;
  /** Detach: stop answering claims and release the channel. */
  stop(): void;
}

const CLAIM = 'claim:';
const TAKEN = 'taken:';

/**
 * Claim the tab's replica id among the other live tabs of this document, so a
 * duplicated tab (whose sessionStorage — and therefore replica id — was COPIED)
 * cannot keep sharing the original's identity (ADR-0009 note 2026-08-22; the
 * shared id meant one `replica_sync` ledger row and one HLC identity for two
 * editing contexts).
 *
 * Protocol (a "duel" on a document-scoped channel):
 * - on start: read-or-mint the id, then announce `claim:<id>`;
 * - on `claim:<held id>`: answer `taken:<held id>` — we hold it, the claimant
 *   must yield;
 * - on `taken:<held id>`: another live tab already held it — we are the
 *   duplicate. Re-mint, persist, announce the fresh claim, and notify the
 *   caller (which rebinds its sync connection under the new id).
 *
 * Symmetric and idempotent: whoever is SECOND to announce loses; a re-minted id
 * is a fresh UUID, so it cannot collide again. A claim announced while no other
 * tab is listening is simply not delivered (BroadcastChannel semantics), which
 * is fine — every joining tab announces its own claim, so the duplicate always
 * probes. Real delivery is asynchronous; the handlers make no ordering
 * assumptions.
 *
 * `channel` may be undefined (no BroadcastChannel in this environment): the id
 * is then minted as usual and simply never duelled — the pre-duel behavior,
 * which the server-side defenses (ADR-0019 in-process live-connection gate)
 * already cover.
 */
export function claimReplicaId(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  channel: ReplicaClaimChannel | undefined,
  mint: () => string = () => crypto.randomUUID(),
  onRemint?: (freshId: string) => void,
): ReplicaIdClaim {
  let id = getOrCreateReplicaId(storage, mint);
  if (!channel) {
    return { get: () => id, stop: () => {} };
  }
  channel.onmessage = (event) => {
    const message = String(event.data);
    if (message === `${CLAIM}${id}`) {
      channel.postMessage(`${TAKEN}${id}`);
    } else if (message === `${TAKEN}${id}`) {
      id = mint();
      storage.setItem(REPLICA_ID_KEY, id);
      channel.postMessage(`${CLAIM}${id}`);
      onRemint?.(id);
    }
  };
  channel.postMessage(`${CLAIM}${id}`);
  return {
    get: () => id,
    stop: () => {
      channel.onmessage = null;
      channel.close();
    },
  };
}

/**
 * Live-app wrapper: duel on the given document-scoped BroadcastChannel using
 * the never-throwing tab storage. The caller owns channel construction (and
 * lifecycle via `stop()`), so this stays testable without a browser.
 */
export function claimTabReplicaId(
  channel: ReplicaClaimChannel | undefined,
  mint: () => string = () => crypto.randomUUID(),
  onRemint?: (freshId: string) => void,
): ReplicaIdClaim {
  return claimReplicaId(tabStorage(), channel, mint, onRemint);
}

