import * as Y from 'yjs';
import { ITEMS_MAP } from '@open-outliner/shared';
import type { YjsStore } from './yjs-store.js';

/**
 * Author tombstone key removals into the durable CRDT plane (ADR-0006/0019).
 *
 * GC hard-delete must remove BOTH the projected `items` row AND the item's Yjs
 * key, or the next projection pass re-upserts the tombstone (the "hard-delete
 * doesn't stick" bug). Key removal is a CRDT operation: it must reach connected
 * clients (broadcast) and reconnecting replicas (the delete op rides normal
 * Yjs sync), so it is persisted to `yjs_updates` as an ordinary update.
 *
 * When a Hocuspocus room is live for the document, the caller should transact
 * on the room's Document instead — Hocuspocus broadcasts the deletion to every
 * connected client AND the Database extension persists it. This helper is the
 * no-live-room fallback: it loads the merged state from the store, deletes the
 * keys, and persists ONLY the delta (the deletion set) as a new update — never
 * a full-state snapshot.
 */
export async function removeTombstoneKeysFromStore(
  store: YjsStore,
  documentId: string,
  itemIds: readonly string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const doc = await store.loadDocument(documentId);
  try {
    const before = Y.encodeStateVector(doc);
    Y.transact(doc, () => {
      const items = doc.getMap(ITEMS_MAP);
      for (const id of itemIds) items.delete(id);
    });
    const delta = Y.encodeStateAsUpdate(doc, before);
    if (delta.length > 0) {
      await store.storeUpdate(documentId, delta);
    }
  } finally {
    doc.destroy();
  }
}
