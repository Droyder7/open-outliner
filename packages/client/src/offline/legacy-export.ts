import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { library, toBase64 } from './library.js';
/** Preserve previous-version libraries before any user-directed reset/import. */
export async function exportPreviousLibrary(accountId: string) {
  const docs = await library.documents
    .where('accountId')
    .equals(accountId)
    .filter((d) => d.schemaVersion !== 2)
    .toArray();
  const archive = [];
  for (const document of docs) {
    const doc = new Y.Doc();
    const store = new IndexeddbPersistence(`oo:personal:${accountId}:${document.id}`, doc);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        store.whenSynced,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Could not load previous document')), 5000);
        }),
      ]);
      archive.push({ ...document, update: toBase64(Y.encodeStateAsUpdate(doc)) });
    } finally {
      clearTimeout(timer);
      await store.destroy();
      doc.destroy();
    }
  }
  const blob = new Blob(
    [
      JSON.stringify(
        { format: 'open-outliner-local-archive', version: 1, documents: archive },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'previous-library.json';
  a.click();
  URL.revokeObjectURL(url);
}
