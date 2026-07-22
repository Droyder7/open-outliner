import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createRoot, getRootId, getChildren, insertItem, type Actor } from '@open-outliner/crdt';

/**
 * A client editing session for one document: the Y.Doc, its local IndexedDB
 * persistence (offline-first, ADR-0015 client side), and — only when a sync URL
 * is configured — a Hocuspocus provider to the Phase 3 server. With no sync URL
 * the app is a fully usable local outliner; the server round-trip is opt-in
 * until the auth boundary (Phase 5) lands.
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
    whenReady: idb.whenSynced.then(() => {
      // Seed a root + first empty bullet once local state has loaded, so a
      // brand-new document is immediately typeable.
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
