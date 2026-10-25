import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { createRoot, insertItem, writeContent, itemsMap, deleteItem } from '@open-outliner/crdt';
import {
  portableDocument,
  instantiatePortable,
  validatePortable,
  markdown,
} from '../src/offline/portable.js';
import { importDocument, checkpoint, recoverCheckpoint } from '../src/offline/recovery.js';
import { library } from '../src/offline/library.js';
function fixture() {
  const doc = new Y.Doc();
  doc.getMap('meta').set('schemaVersion', 2);
  doc.getMap('meta').set('rootId', 'root');
  doc.getMap('meta').set('title', 'Ideas');
  const actor = { replicaId: 'test', now: () => 1 };
  createRoot(doc, 'root', actor);
  insertItem(doc, 'item', 'root', undefined, actor);
  writeContent(doc, 'item', 'A good idea');
  itemsMap(doc).get('item')!.set('note', new Y.Text('Supporting detail'));
  return { doc, actor };
}
beforeEach(async () => {
  await library.documents.clear();
  await library.pending.clear();
  await library.checkpoints.clear();
});
describe('portable outlines and recovery', () => {
  it('round-trips live hierarchy, text and notes with fresh identities', () => {
    const { doc } = fixture();
    const data = portableDocument(doc);
    const copy = instantiatePortable(data, crypto.randomUUID());
    const out = portableDocument(copy);
    expect(out.title).toBe(data.title);
    expect(out.items.map((i) => [i.content, i.note, i.type, i.isCompleted]).sort()).toEqual(
      data.items.map((i) => [i.content, i.note, i.type, i.isCompleted]).sort(),
    );
    expect(out.items.some((i) => i.id === 'item')).toBe(false);
    expect(markdown(data)).toContain('A good idea');
    doc.destroy();
    copy.destroy();
  });
  it('excludes trash from normal export but retains it in recovery snapshots', () => {
    const { doc, actor } = fixture();
    deleteItem(doc, 'item', actor);
    expect(portableDocument(doc).items).toHaveLength(1);
    expect(portableDocument(doc, true).items).toHaveLength(2);
    doc.destroy();
  });
  it('invalid input makes no partial catalog or pending records', async () => {
    const { doc } = fixture();
    const data = portableDocument(doc);
    data.items[0]!.parentId = 'missing';
    expect(() => validatePortable(data)).toThrow();
    await expect(importDocument(data, { id: 'local' })).rejects.toThrow();
    expect(await library.documents.count()).toBe(0);
    expect(await library.pending.count()).toBe(0);
    doc.destroy();
  });
  it('checkpoint recovery creates a new document and enforces account ownership', async () => {
    const { doc } = fixture();
    await checkpoint(doc, 'owner', 'original', 'Manual');
    const saved = (await library.checkpoints.toArray())[0]!;
    await expect(recoverCheckpoint(saved.id, { id: 'other' })).rejects.toThrow();
    const id = await recoverCheckpoint(saved.id, { id: 'owner' });
    expect(id).not.toBe('original');
    expect((await library.documents.get(id))!.title).toBe('Recovered Ideas');
    expect(await library.pending.count()).toBe(1);
    expect(await library.checkpoints.count()).toBe(1);
    doc.destroy();
  });
});
