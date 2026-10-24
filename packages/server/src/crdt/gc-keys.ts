import * as Y from 'yjs';
import { ITEMS_MAP } from '@open-outliner/shared';
import type { YjsStore } from './yjs-store.js';

/** A document retained before GC acquires its advisory lock (ADR-0020). */
export interface PreparedTombstoneKeyRemoval {
  /** Remove keys and durably persist the delta without loading stored history. */
  remove(itemIds: readonly string[]): Promise<void>;
  /** Release the document AFTER the GC transaction ends, including on failure. */
  release(): Promise<void>;
}

/**
 * Remove keys from an already-loaded document. For a Hocuspocus room the
 * transaction also broadcasts deletions. Persist immediately, before GC deletes
 * projected rows; the Database extension's debounced store is not sufficient.
 */
export async function removeTombstoneKeysFromDocument(
  store: YjsStore,
  documentId: string,
  doc: Y.Doc,
  itemIds: readonly string[],
): Promise<void> {
  if (doc.isDestroyed) throw new Error('GC document was released');
  if (itemIds.length === 0) return;
  const before = Y.encodeStateVector(doc);
  Y.transact(doc, () => {
    const items = doc.getMap(ITEMS_MAP);
    for (const id of itemIds) items.delete(id);
  });
  const delta = Y.encodeStateAsUpdate(doc, before);
  if (delta.length > 0) await store.storeUpdate(documentId, delta);
}

/** Headless store adapter: replay happens at preparation, never during remove. */
export async function prepareTombstoneKeysFromStore(
  store: YjsStore,
  documentId: string,
): Promise<PreparedTombstoneKeyRemoval> {
  const doc = await store.loadDocument(documentId);
  return {
    remove: (itemIds) => removeTombstoneKeysFromDocument(store, documentId, doc, itemIds),
    async release() {
      doc.destroy();
    },
  };
}
