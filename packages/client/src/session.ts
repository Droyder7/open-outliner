import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createRoot, getRootId, getChildren, insertItem, type Actor } from '@open-outliner/crdt';
import { setStorageStatus } from './offline/storage-status.js';
import { claimTabReplicaId, getOrCreateTabReplicaId, type ReplicaClaimChannel, type ReplicaIdClaim } from './replica-id.js';
import { syncAckPayload } from './sync-ack.js';

/**
 * A client editing session for one document: the Y.Doc, its local IndexedDB
 * persistence (offline-first, ADR-0015 client side), and — only when a sync URL
 * is configured — a Hocuspocus provider to the Phase 3 server, authenticated by
 * the session cookie the browser attaches to the WS handshake automatically
 * (Phase 5/SEC). With no sync URL the app is a fully usable local outliner.
 */

/**
 * Wait (briefly) for the provider's first server sync before deciding
 * whether this document needs a root seeded. Without this, a fresh browser
 * tab with an empty local IndexedDB cache — opening a document that already
 * exists server-side (e.g. created via the `CreateDocument` RPC) — could
 * author its OWN root before the real state arrives over the socket,
 * racing the "exactly one root per document" invariant. Bounded so a
 * genuinely offline client still becomes usable (product principle #1):
 * no server round trip is required to type.
 *
 * Reads the provider through a getter: the provider can be REPLACED at most
 * once (a lost duplicate-tab duel rebinds the sync connection under a fresh
 * replica id), and the wait must follow the replacement rather than hang on
 * a destroyed provider until the timeout.
 */
function waitForInitialSync(
  getProvider: () => HocuspocusProvider | undefined,
  timeoutMs = 4000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    };
    const poll = setInterval(() => {
      if (getProvider()?.synced) settle();
    }, 50);
    const timer = setTimeout(settle, timeoutMs);
  });
}

/**
 * Wait for the local `y-indexeddb` store to load, but never hang or crash
 * the app on it (offline-and-pwa.md "local corruption" / "failed IndexedDB
 * transaction"): a store that fails to open or takes too long falls back to
 * a fresh in-memory doc, surfaced via `storage-status` rather than silently
 * swallowed. The in-memory Yjs doc keeps working regardless — only
 * cross-reload durability is at risk.
 */
function waitForLocalPersistence(idb: IndexeddbPersistence, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      setStorageStatus('memory-only');
      resolve();
    }, timeoutMs);
    idb.whenSynced.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        setStorageStatus('memory-only');
        resolve();
      },
    );
  });
}

export interface Session {
  readonly doc: Y.Doc;
  readonly actor: Actor;
  readonly documentId: string;
  readonly rootId: string;
  readonly whenReady: Promise<void>;
  destroy(): void;
}

export function createSession(documentId: string): Session {
  const doc = new Y.Doc();
  const initialReplicaId = getReplicaId();
  const actor: Actor = { replicaId: initialReplicaId, now: () => Date.now() };
  // The document's synthetic root uses the document id as its item id, so every
  // replica derives the SAME root id and can never create a second root.
  const rootId = documentId;

  const idb = new IndexeddbPersistence(`oo:${documentId}`, doc);

  const syncUrl = import.meta.env.VITE_SYNC_URL;
  // The replica id the sync connection identifies as. Starts as the tab's id
  // and is replaced (with the connection) at most once, if this tab loses the
  // duplicate-tab duel below. The actor's HLC stamps keep the id they were
  // minted with: the id is metadata (Yjs's per-instance client id remains the
  // concurrent-write arbiter), so stamps under the pre-duel id stay valid.
  let replicaId = initialReplicaId;
  let provider: HocuspocusProvider | undefined;

  // Hocuspocus requires a non-empty `token` whenever the server defines
  // `onAuthenticate`. Auth itself is the httpOnly session cookie on the WS
  // upgrade (ADR-0014) — the token value is ignored server-side. Prefer a
  // same-origin URL (Vite proxies `/collaboration` → :8788) so the cookie
  // is always attached; `ws://localhost:8788` cross-port can drop it.
  const makeProvider = (id: string, url: string): HocuspocusProvider =>
    new HocuspocusProvider({
      url,
      name: documentId,
      document: doc,
      token: 'cookie',
      // ADR-0019: the server reads this per-tab HLC replica id (ADR-0009) from
      // the WS URL and gates tombstone-aware GC on this replica's sync
      // acknowledgement.
      parameters: { replicaId: id },
      onSynced: ({ state }) => {
        // Stateless ack (ADR-0019): a completed sync means this replica has
        // received every tombstone broadcast up to this point. Sent on every
        // initial sync / reconnect (the provider re-acks after a drop); the
        // send decision is the pure syncAckPayload helper (sync-ack.ts).
        const payload = syncAckPayload(state);
        if (payload) provider?.sendStateless(payload);
      },
      onAuthenticationFailed: ({ reason }) => {
        // Expected on logout/revocation (ADR-0014); avoid spamming the console.
        if (reason === 'permission-denied' || reason === 'Forbidden') return;
        console.warn('[sync] authentication failed:', reason);
      },
      onClose: ({ event }) => {
        // 1000 = normal; 4401/4403 = session revoked / auth rejected (logout path).
        if (!event?.code || event.code === 1000 || event.code === 4401 || event.code === 4403) {
          return;
        }
        console.warn('[sync] websocket closed:', event.code, event.reason);
      },
    });

  if (syncUrl) provider = makeProvider(replicaId, syncUrl);

  // Duplicate-tab duel (ADR-0009 note, 2026-08-22): "Duplicate Tab" copies
  // sessionStorage, so the duplicate would start with the original's replica
  // id — two editing contexts sharing one `replica_sync` row and one HLC
  // identity. The loser of the duel (whoever announced second) re-mints,
  // persists the fresh id, and rebinds its sync connection under it. The
  // original tab keeps its id; the shared row is left to expire via the
  // stale-replica TTL (the safe direction — it keeps blocking GC).
  const claim: ReplicaIdClaim | undefined = syncUrl
    ? claimTabReplicaId(
        claimChannel(documentId),
        undefined,
        (freshId) => {
          replicaId = freshId;
          provider?.destroy();
          provider = makeProvider(freshId, syncUrl);
        },
      )
    : undefined;

  const session: Session = {
    doc,
    actor,
    documentId,
    rootId,
    whenReady: Promise.all([waitForLocalPersistence(idb), waitForInitialSync(() => provider)]).then(
      () => {
        // Seed a root + first empty bullet once local AND (if configured) server
        // state has loaded, so a brand-new document is immediately typeable
        // without racing an existing server-seeded root (see waitForInitialSync).
        if (!getRootId(doc)) createRoot(doc, rootId, actor);
        if (getChildren(doc, rootId).length === 0) {
          insertItem(doc, crypto.randomUUID(), rootId, undefined, actor);
        }
      },
    ),
    destroy() {
      claim?.stop();
      provider?.destroy();
      void idb.destroy();
      doc.destroy();
    },
  };
  return session;
}

/**
 * A stable per-TAB replica id — the HLC tie-breaker (ADR-0009), NOT a user id.
 * `sessionStorage` scopes it to this tab (survives refresh, dies with the tab)
 * so every tab is its own replica with its own `replica_sync` ack row: one tab
 * syncing can never unblock GC for a sibling tab still mid-sync (ADR-0019).
 * Never throws, even where sessionStorage is unavailable (see replica-id.ts).
 * Sharing via "Duplicate Tab" is detected and healed by the claim duel in
 * createSession (ADR-0009 note, 2026-08-22).
 */
function getReplicaId(): string {
  return getOrCreateTabReplicaId();
}

/**
 * The document-scoped BroadcastChannel for the duplicate-tab duel, adapted to
 * the minimal ReplicaClaimChannel seam (so the duel logic stays testable
 * without a browser). undefined where BroadcastChannel doesn't exist — the
 * duel then simply doesn't run, which the server-side defenses already cover.
 */
function claimChannel(documentId: string): ReplicaClaimChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  const bc = new BroadcastChannel(`oo:replica-claim:${documentId}`);
  let handler: ReplicaClaimChannel['onmessage'] = null;
  return {
    postMessage: (data) => bc.postMessage(data),
    close: () => bc.close(),
    get onmessage() {
      return handler;
    },
    set onmessage(h) {
      handler = h;
      bc.onmessage = h ? (ev) => h({ data: String(ev.data) }) : null;
    },
  };
}
