import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createRoot, getRootId, getChildren, insertItem, type Actor } from '@open-outliner/crdt';

/**
 * A client editing session for one document: the Y.Doc, its local IndexedDB
 * persistence (offline-first, ADR-0015 client side), and — only when a sync URL
 * is configured — a Hocuspocus provider to the Phase 3 server, authenticated by
 * the session cookie the browser attaches to the WS handshake automatically
 * (Phase 5/SEC). With no sync URL the app is a fully usable local outliner.
 */

const REPLICA_KEY = 'oo:replicaId';

/** A stable per-install replica id — the HLC tie-breaker (ADR-0009), NOT a user id. */
function getReplicaId(): string {
  let id = localStorage.getItem(REPLICA_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(REPLICA_KEY, id);
  }
  return id;
}

/**
 * Wait (briefly) for the provider's first server sync before deciding
 * whether this document needs a root seeded. Without this, a fresh browser
 * tab with an empty local IndexedDB cache — opening a document that already
 * exists server-side (e.g. created via the `CreateDocument` RPC) — could
 * author its OWN root before the real state arrives over the socket,
 * racing the "exactly one root per document" invariant. Bounded so a
 * genuinely offline client still becomes usable (product principle #1):
 * no server round trip is required to type.
 */
function waitForInitialSync(provider: HocuspocusProvider | undefined, timeoutMs = 4000): Promise<void> {
  if (!provider) return Promise.resolve();
  if (provider.synced) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const onSynced = (): void => {
      clearTimeout(timer);
      provider.off('synced', onSynced);
      resolve();
    };
    provider.on('synced', onSynced);
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
  const actor: Actor = { replicaId: getReplicaId(), now: () => Date.now() };
  // The document's synthetic root uses the document id as its item id, so every
  // replica derives the SAME root id and can never create a second root.
  const rootId = documentId;

  const idb = new IndexeddbPersistence(`oo:${documentId}`, doc);

  const syncUrl = import.meta.env.VITE_SYNC_URL;
  let provider: HocuspocusProvider | undefined;
  if (syncUrl) {
    provider = new HocuspocusProvider({ url: syncUrl, name: documentId, document: doc });
  }

  const session: Session = {
    doc,
    actor,
    documentId,
    rootId,
    whenReady: Promise.all([idb.whenSynced, waitForInitialSync(provider)]).then(() => {
      // Seed a root + first empty bullet once local AND (if configured) server
      // state has loaded, so a brand-new document is immediately typeable
      // without racing an existing server-seeded root (see waitForInitialSync).
      if (!getRootId(doc)) createRoot(doc, rootId, actor);
      if (getChildren(doc, rootId).length === 0) {
        insertItem(doc, crypto.randomUUID(), rootId, undefined, actor);
      }
    }),
    destroy() {
      provider?.destroy();
      void idb.destroy();
      doc.destroy();
    },
  };
  return session;
}

