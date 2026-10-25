import * as Y from 'yjs';
import { library, type Account } from './library.js';
import { instantiatePortable, portableDocument, validatePortable } from './portable.js';
export async function checkpoint(
  doc: Y.Doc,
  accountId: string,
  documentId: string,
  reason: string,
) {
  await library.checkpoints.add({
    id: crypto.randomUUID(),
    accountId,
    documentId,
    title: String(doc.getMap('meta').get('title') ?? 'Untitled'),
    bytes: Y.encodeStateAsUpdate(doc),
    createdAt: Date.now(),
    reason,
  });
}
export async function importDocument(input: unknown, account: Account) {
  const value = validatePortable(input);
  const id = crypto.randomUUID();
  const doc = instantiatePortable(value, id);
  try {
    await library.transaction('rw', library.documents, library.pending, async () => {
      await library.documents.add({
        id,
        accountId: account.id,
        title: value.title,
        registered: false,
        schemaVersion: 2,
        modifiedAt: Date.now(),
        ...(account.workspaceId ? { workspaceId: account.workspaceId } : {}),
      });
      await library.pending.add({
        id: crypto.randomUUID(),
        accountId: account.id,
        documentId: id,
        bytes: Y.encodeStateAsUpdate(doc),
        createdAt: Date.now(),
      });
    });
    return id;
  } finally {
    doc.destroy();
  }
}
export async function recoverCheckpoint(id: string, account: Account) {
  const saved = await library.checkpoints.get(id);
  if (!saved || saved.accountId !== account.id) throw new Error('Checkpoint unavailable');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, saved.bytes);
    const data = portableDocument(doc, true);
    data.title = `Recovered ${saved.title}`;
    return await importDocument(data, account);
  } finally {
    doc.destroy();
  }
}
export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
