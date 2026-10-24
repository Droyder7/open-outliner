import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { deriveEffectiveTree } from '@open-outliner/shared';
import {
  createRoot,
  insertItem,
  getChildren,
  deleteItem,
  undeleteItem,
  itemsMap,
  readDeleted,
  writeMove,
  readMove,
  getContentYText,
  createOutlineHistory,
} from '../src/index.js';
const actor = { replicaId: 'local', now: () => 1000 };
function setup() {
  const doc = new Y.Doc();
  doc.getMap('meta').set('schemaVersion', 2);
  doc.getMap('meta').set('rootId', 'root');
  createRoot(doc, 'root', actor);
  insertItem(doc, 'a', 'root', undefined, actor);
  return doc;
}
function fork(doc: Y.Doc) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc), 'remote');
  return other;
}
function merge(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
}
describe('personal tree semantics', () => {
  it('recovers cycles and missing parents deterministically regardless of input order', () => {
    const nodes = [
      { id: 'root', parentId: 'ignored', isDeleted: false },
      { id: 'a', parentId: 'b', isDeleted: false },
      { id: 'b', parentId: 'a', isDeleted: false },
      { id: 'orphan', parentId: 'absent', isDeleted: false },
    ];
    for (const order of [nodes, [...nodes].reverse()]) {
      const tree = deriveEffectiveTree(order, 'root');
      expect(tree.parents.get('a')).toBe('root');
      expect(tree.parents.get('b')).toBe('a');
      expect(tree.recovered).toEqual(new Set(['a', 'orphan']));
    }
  });
  it('concurrent delete survives restore of only observed delete records', () => {
    const a = setup();
    deleteItem(a, 'a', actor);
    const b = fork(a);
    undeleteItem(a, 'a', actor);
    deleteItem(b, 'a', actor);
    merge(a, b);
    expect(readDeleted(itemsMap(a).get('a')!).isDeleted).toBe(true);
    expect(getChildren(a, 'root')).toHaveLength(0);
    undeleteItem(a, 'a', actor);
    merge(a, b);
    expect(getChildren(b, 'root')).toHaveLength(1);
    a.destroy();
    b.destroy();
  });
  it('an edit does not restore trash; moving a descendant out preserves it', () => {
    const doc = setup();
    insertItem(doc, 'child', 'a', undefined, actor);
    deleteItem(doc, 'a', actor);
    getContentYText(doc, 'a')!.insert(0, 'still trash');
    expect(getChildren(doc, 'root')).toHaveLength(0);
    const move = readMove(itemsMap(doc).get('child')!)!;
    writeMove(doc, 'child', { ...move, parentId: 'root' });
    expect(getChildren(doc, 'root').map((n) => n.id)).toEqual(['child']);
    doc.destroy();
  });
  it('native Yjs placement converges without promising wall-clock winners', () => {
    const a = setup(),
      b = fork(a);
    a.clientID = 10;
    b.clientID = 20;
    writeMove(a, 'a', {
      parentId: 'parent-A',
      rank: 'a0',
      hlc: { wallMs: 1000, counter: 0, replicaId: 'A' },
    });
    writeMove(b, 'a', {
      parentId: 'parent-B',
      rank: 'a0',
      hlc: { wallMs: 10, counter: 0, replicaId: 'B' },
    });
    merge(a, b);
    expect(readMove(itemsMap(a).get('a')!)).toEqual(readMove(itemsMap(b).get('a')!));
    expect(readMove(itemsMap(a).get('a')!)!.parentId).toBe('parent-B');
    writeMove(a, 'a', {
      parentId: 'root',
      rank: 'a0',
      hlc: { wallMs: 1, counter: 0, replicaId: 'A' },
    });
    merge(a, b);
    expect(readMove(itemsMap(b).get('a')!)!.parentId).toBe('root');
    a.destroy();
    b.destroy();
  });
  it('arbitrary tree placements always yield a root-reachable acyclic view', () => {
    let seed = 7;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let run = 0; run < 100; run++) {
      const nodes = [
        { id: 'root', parentId: 'root', isDeleted: false },
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `n${i}`,
          parentId: `n${next() % 42}`,
          isDeleted: false,
        })),
      ];
      const tree = deriveEffectiveTree(nodes, 'root');
      for (const node of nodes) {
        const seen = new Set<string>();
        let id = node.id;
        while (id !== 'root') {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
          id = tree.parents.get(id)!;
          expect(typeof id).toBe('string');
        }
      }
      expect([...deriveEffectiveTree([...nodes].reverse(), 'root').parents].sort()).toEqual(
        [...tree.parents].sort(),
      );
    }
  });
  it('root placement and root deletion are immutable', () => {
    const doc = setup();
    writeMove(doc, 'root', {
      parentId: 'a',
      rank: 'a0',
      hlc: { wallMs: 9, counter: 0, replicaId: 'x' },
    });
    deleteItem(doc, 'root', actor);
    expect(readMove(itemsMap(doc).get('root')!)!.parentId).not.toBe('a');
    expect(readDeleted(itemsMap(doc).get('root')!).isDeleted).toBe(false);
    doc.destroy();
  });
  it('undo of an insertion trashes rather than physically removing its identity', () => {
    const doc = setup();
    const history = createOutlineHistory(doc);
    insertItem(doc, 'new', 'root', undefined, actor);
    history.undo();
    expect(itemsMap(doc).has('new')).toBe(true);
    expect(readDeleted(itemsMap(doc).get('new')!).isDeleted).toBe(true);
    history.redo();
    expect(readDeleted(itemsMap(doc).get('new')!).isDeleted).toBe(false);
    history.stop();
    doc.destroy();
  });
  it('undo of a move never restores a concurrently deleted item', () => {
    const doc = setup();
    insertItem(doc, 'parent', 'root', undefined, actor);
    const other = fork(doc);
    const history = createOutlineHistory(doc);
    const old = readMove(itemsMap(doc).get('a')!)!;
    writeMove(doc, 'a', { ...old, parentId: 'parent' });
    deleteItem(other, 'a', actor);
    merge(doc, other);
    history.undo();
    expect(readDeleted(itemsMap(doc).get('a')!).isDeleted).toBe(true);
    history.stop();
    doc.destroy();
    other.destroy();
  });
  it('local text undo preserves incoming remote text', () => {
    const doc = setup();
    const text = getContentYText(doc, 'a')!;
    const other = fork(doc);
    const remote = getContentYText(other, 'a')!;
    const history = createOutlineHistory(doc);
    text.insert(0, 'local');
    remote.insert(0, 'remote');
    merge(doc, other);
    history.undo();
    expect(text.toString()).toBe('remote');
    history.stop();
    doc.destroy();
    other.destroy();
  });
});
