import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  createRoot,
  insertItem,
  indent,
  outdent,
  moveWithinSiblings,
  moveItem,
  deleteItem,
  undeleteItem,
  getChildren,
  flattenVisible,
  isDescendantOf,
  getRootId,
  getContentYText,
  getIsCollapsed,
  setIsCollapsed,
  getIsCompleted,
  toggleCompleted,
  mergeIntoPrevious,
  splitItem,
  getParentId,
  hasChildren,
  getContentText,
  type Actor,
} from '../src/outline.js';

/** A deterministic actor for reproducible tests: ticking clock, fixed replica. */
function testActor(): Actor {
  let clock = 1;
  return { replicaId: 'test-replica', now: () => clock++ };
}

describe('outline model — structural commands (ADR-0017)', () => {
  let doc: Y.Doc;
  let rootId: string;
  let actor: Actor;

  beforeEach(() => {
    doc = new Y.Doc();
    actor = testActor();
    rootId = randomUUID();
    createRoot(doc, rootId, actor);
  });

  it('createRoot seeds exactly one root item findable by getRootId', () => {
    expect(getRootId(doc)).toBe(rootId);
  });

  it('insertItem appends children in read order', () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, rootId, a, actor);
    insertItem(doc, c, rootId, b, actor);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a, b, c]);
  });

  it('insertItem in the middle lands between its neighbors', () => {
    const a = randomUUID();
    const c = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, c, rootId, a, actor);
    const b = randomUUID();
    insertItem(doc, b, rootId, a, actor); // between a and c
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a, b, c]);
  });

  it('indent makes the item the last child of its previous sibling', () => {
    const a = randomUUID();
    const b = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, rootId, a, actor);
    expect(indent(doc, b, actor)).toBe(true);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]);
    expect(getChildren(doc, a).map((n) => n.id)).toEqual([b]);
  });

  it('indent is a no-op with no previous sibling', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    expect(indent(doc, a, actor)).toBe(false);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]);
  });

  it('outdent makes the item the next sibling of its parent', () => {
    const a = randomUUID();
    const b = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, a, undefined, actor); // b is a's child
    expect(outdent(doc, b, actor)).toBe(true);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a, b]);
  });

  it('outdent is a no-op at top level', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    expect(outdent(doc, a, actor)).toBe(false);
  });

  it('moveWithinSiblings up/down reorders without changing parent', () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, rootId, a, actor);
    insertItem(doc, c, rootId, b, actor);
    expect(moveWithinSiblings(doc, c, 'up', actor)).toBe(true);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a, c, b]);
    expect(moveWithinSiblings(doc, a, 'up', actor)).toBe(false); // already first
  });

  it('moveItem rejects dropping an item into its own descendant (cycle guard)', () => {
    const a = randomUUID();
    const b = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, a, undefined, actor); // b is a's child
    expect(isDescendantOf(doc, b, a)).toBe(true);
    expect(moveItem(doc, a, b, undefined, actor)).toBe(false); // a into its own child b
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]); // unchanged
  });

  it('moveItem re-parents into a valid target', () => {
    const a = randomUUID();
    const b = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, rootId, a, actor);
    expect(moveItem(doc, b, a, undefined, actor)).toBe(true);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]);
    expect(getChildren(doc, a).map((n) => n.id)).toEqual([b]);
  });

  it('deleteItem hides the subtree root and its descendants from live reads (lazy tombstone)', () => {
    const a = randomUUID();
    const b = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, a, undefined, actor);
    deleteItem(doc, a, actor);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([]);
    expect(getChildren(doc, a).map((n) => n.id)).toEqual([]); // b filtered under deleted ancestor
  });

  it('undeleteItem restores visibility with a strictly-greater HLC', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    deleteItem(doc, a, actor);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([]);
    undeleteItem(doc, a, actor);
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]);
  });

  it('flattenVisible respects collapse state', () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, a, undefined, actor);
    insertItem(doc, c, rootId, a, actor);
    const collapsed = new Set([a]);
    expect(flattenVisible(doc, rootId, (id) => collapsed.has(id))).toEqual([a, c]);
    collapsed.delete(a);
    expect(flattenVisible(doc, rootId, (id) => collapsed.has(id))).toEqual([a, b, c]);
  });

  it('setIsCollapsed/getIsCollapsed round-trip as a view flag, not structure', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    expect(getIsCollapsed(doc, a)).toBe(false);
    setIsCollapsed(doc, a, true);
    expect(getIsCollapsed(doc, a)).toBe(true);
    // Still a live child of root — collapse never alters structure.
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]);
  });

  it('toggleCompleted flips the LWW isCompleted flag', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    expect(getIsCompleted(doc, a)).toBe(false);
    toggleCompleted(doc, a);
    expect(getIsCompleted(doc, a)).toBe(true);
    toggleCompleted(doc, a);
    expect(getIsCompleted(doc, a)).toBe(false);
  });

  it('mergeIntoPrevious appends text, re-parents children, and tombstones the source', () => {
    const a = randomUUID();
    const b = randomUUID();
    const child = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, rootId, a, actor);
    insertItem(doc, child, b, undefined, actor);
    getContentYText(doc, a)!.insert(0, 'hello ');
    getContentYText(doc, b)!.insert(0, 'world');

    expect(mergeIntoPrevious(doc, b, a, actor)).toBe(true);
    expect(getContentYText(doc, a)!.toString()).toBe('hello world');
    // b's child is re-parented onto a; b itself is gone from live reads.
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a]);
    expect(getChildren(doc, a).map((n) => n.id)).toEqual([child]);
  });

  it('getParentId and hasChildren reflect live structure', () => {
    const a = randomUUID();
    const b = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    insertItem(doc, b, a, undefined, actor);
    expect(getParentId(doc, a)).toBe(rootId);
    expect(getParentId(doc, b)).toBe(a);
    expect(hasChildren(doc, a)).toBe(true);
    expect(hasChildren(doc, b)).toBe(false);
  });

  it('splitItem keeps the prefix, moves the suffix to a new sibling below', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    getContentYText(doc, a)!.insert(0, 'hello world');

    const newId = randomUUID();
    expect(splitItem(doc, a, 5, newId, actor)).toBe(true);

    expect(getContentText(doc, a)).toBe('hello');
    expect(getContentText(doc, newId)).toBe(' world');
    // The new item is a's next sibling (same parent), ordered immediately after.
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a, newId]);
    expect(getParentId(doc, newId)).toBe(rootId);
  });

  it('splitItem at end of text creates an empty new sibling (Enter on a full line)', () => {
    const a = randomUUID();
    insertItem(doc, a, rootId, undefined, actor);
    getContentYText(doc, a)!.insert(0, 'done');

    const newId = randomUUID();
    splitItem(doc, a, 4, newId, actor);
    expect(getContentText(doc, a)).toBe('done');
    expect(getContentText(doc, newId)).toBe('');
    expect(getChildren(doc, rootId).map((n) => n.id)).toEqual([a, newId]);
  });
});
