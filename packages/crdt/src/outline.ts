import * as Y from 'yjs';
import {
  ROOT_PARENT_SENTINEL,
  isRootParent,
  compareOrder,
  buildInsertMove,
  buildMove,
  buildAppendMove,
  buildDelete,
  buildUndelete,
  buildRootMove,
  rankBetween,
  type Hlc,
  type ClockContext,
} from '@open-outliner/shared';
import {
  itemsMap,
  readMove,
  readDeleted,
  writeMove,
  writeDeleted,
  writeField,
  nodeText,
  contentText,
} from './yjs-node.js';
import { NODE_KEY, isItemType, type ItemType } from '@open-outliner/shared';

/**
 * The outline model: read/query helpers and structural commands over a live
 * Y.Doc, built on the shared pure command builders (item-commands.ts) and the
 * yjs-node binding. Every structural command here performs ONE atomic `move`
 * write (ADR-0010) — this is what the Phase 4 editor's keymap (ADR-0017) calls.
 */

export interface OutlineNode {
  readonly id: string;
  readonly parentId: string; // ROOT_PARENT_SENTINEL for the root item
  readonly rank: string;
  readonly hlc: Hlc;
  readonly isDeleted: boolean;
}

function readOutlineNode(id: string, node: Y.Map<unknown>): OutlineNode | undefined {
  const move = readMove(node);
  if (!move) return undefined;
  return {
    id,
    parentId: move.parentId,
    rank: move.rank,
    hlc: move.hlc,
    isDeleted: readDeleted(node).isDeleted,
  };
}

/** All items in the document, live Yjs read (not a snapshot copy). */
function allNodes(doc: Y.Doc): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const [id, node] of itemsMap(doc)) {
    const n = readOutlineNode(id, node);
    if (n) out.push(n);
  }
  return out;
}

/** Effective-deleted check under the lazy tombstone rule (ADR-0006/0011). */
function isEffectivelyDeleted(byId: Map<string, OutlineNode>, id: string): boolean {
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur) {
    if (seen.has(cur.id)) return false; // cycle guard
    seen.add(cur.id);
    if (cur.isDeleted) return true;
    if (isRootParent(cur.parentId)) return false;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** The document's single root item id, or undefined if not yet created. */
export function getRootId(doc: Y.Doc): string | undefined {
  for (const [id, node] of itemsMap(doc)) {
    const move = readMove(node);
    if (move && isRootParent(move.parentId)) return id;
  }
  return undefined;
}

/** Live (non-deleted, ancestor-non-deleted) children of `parentId`, in read order. */
export function getChildren(doc: Y.Doc, parentId: string): OutlineNode[] {
  const nodes = allNodes(doc);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => n.parentId === parentId && !isEffectivelyDeleted(byId, n.id))
    .sort(compareOrder);
}

/** The flattened, collapse-aware visible order used by caret nav / multi-select (ADR-0017). */
export function flattenVisible(
  doc: Y.Doc,
  rootId: string,
  isCollapsed: (id: string) => boolean,
): string[] {
  const out: string[] = [];
  function walk(parentId: string): void {
    for (const child of getChildren(doc, parentId)) {
      out.push(child.id);
      if (!isCollapsed(child.id)) walk(child.id);
    }
  }
  walk(rootId);
  return out;
}

export interface Actor {
  readonly replicaId: string;
  readonly now: () => number;
}

function ctx(actor: Actor): ClockContext {
  return { replicaId: actor.replicaId, nowMs: actor.now() };
}

/** Create the document's synthetic root item. Call once per new document. */
export function createRoot(doc: Y.Doc, rootId: string, actor: Actor): void {
  writeMove(doc, rootId, buildRootMove(rankBetween(null, null), ctx(actor)));
}

/**
 * Insert a new item as a child of `parentId`, positioned between `afterId` and
 * its next sibling (or at the end if `afterId` is undefined/last). Mirrors
 * Enter-split (ADR-0017): the caller creates the new id and sets its content.
 */
export function insertItem(
  doc: Y.Doc,
  newId: string,
  parentId: string,
  afterId: string | undefined,
  actor: Actor,
): void {
  const siblings = getChildren(doc, parentId);
  const afterIndex = afterId ? siblings.findIndex((s) => s.id === afterId) : -1;
  const lower = afterIndex >= 0 ? siblings[afterIndex]!.rank : null;
  const upper = afterIndex >= 0 ? (siblings[afterIndex + 1]?.rank ?? null) : (siblings[0]?.rank ?? null);
  const move = buildInsertMove(newId, parentId, lower, upper, undefined, ctx(actor));
  writeMove(doc, newId, move);
}

/** Indent: item becomes the last child of its previous sibling. No-op if none (ADR-0017). */
export function indent(doc: Y.Doc, id: string, actor: Actor): boolean {
  const node = itemsMap(doc).get(id);
  const move = node && readMove(node);
  if (!move) return false;
  const siblings = getChildren(doc, move.parentId);
  const idx = siblings.findIndex((s) => s.id === id);
  if (idx <= 0) return false; // no previous sibling — invalid op, no-op (ADR-0017)

  const prevSibling = siblings[idx - 1]!;
  const newSiblings = getChildren(doc, prevSibling.id);
  const lastRank = newSiblings.length > 0 ? newSiblings[newSiblings.length - 1]!.rank : null;
  writeMove(doc, id, buildAppendMove(id, prevSibling.id, lastRank, move.hlc, ctx(actor)));
  return true;
}

/** Outdent: item becomes the next sibling of its parent. No-op at top level (ADR-0017). */
export function outdent(doc: Y.Doc, id: string, actor: Actor): boolean {
  const node = itemsMap(doc).get(id);
  const move = node && readMove(node);
  if (!move) return false;
  const parentNode = itemsMap(doc).get(move.parentId);
  const parentMove = parentNode && readMove(parentNode);
  if (!parentMove) return false; // dangling parent — nothing to outdent into

  const grandparentId = parentMove.parentId;
  if (isRootParent(grandparentId)) {
    // The parent IS the document root; there is no level above top-level.
    return false;
  }
  const parentSiblings = getChildren(doc, grandparentId);
  const parentIdx = parentSiblings.findIndex((s) => s.id === move.parentId);
  const afterRank = parentSiblings[parentIdx]!.rank;
  const nextRank = parentSiblings[parentIdx + 1]?.rank ?? null;
  const rank = rankBetween(afterRank, nextRank, id);
  writeMove(doc, id, buildMove(grandparentId, rank, move.hlc, ctx(actor)));
  return true;
}

/** Move an item up/down among its siblings (Cmd/Ctrl-↑↓, ADR-0017). No-op at the boundary. */
export function moveWithinSiblings(doc: Y.Doc, id: string, direction: 'up' | 'down', actor: Actor): boolean {
  const node = itemsMap(doc).get(id);
  const move = node && readMove(node);
  if (!move) return false;
  const siblings = getChildren(doc, move.parentId);
  const idx = siblings.findIndex((s) => s.id === id);
  if (idx < 0) return false;

  if (direction === 'up') {
    if (idx === 0) return false;
    const before = siblings[idx - 2]?.rank ?? null;
    const rank = rankBetween(before, siblings[idx - 1]!.rank, id);
    writeMove(doc, id, buildMove(move.parentId, rank, move.hlc, ctx(actor)));
    return true;
  }
  if (idx === siblings.length - 1) return false;
  const after = siblings[idx + 2]?.rank ?? null;
  const rank = rankBetween(siblings[idx + 1]!.rank, after, id);
  writeMove(doc, id, buildMove(move.parentId, rank, move.hlc, ctx(actor)));
  return true;
}

/** Re-parent + reposition an item (drag, ADR-0017). Rejects a drop into own descendant. */
export function moveItem(
  doc: Y.Doc,
  id: string,
  newParentId: string,
  afterId: string | undefined,
  actor: Actor,
): boolean {
  if (isDescendantOf(doc, newParentId, id) || newParentId === id) return false; // invalid drop, no-op
  const node = itemsMap(doc).get(id);
  const move = node && readMove(node);
  if (!move) return false;
  const siblings = getChildren(doc, newParentId);
  const afterIndex = afterId ? siblings.findIndex((s) => s.id === afterId) : -1;
  const lower = afterIndex >= 0 ? siblings[afterIndex]!.rank : null;
  const upper = afterIndex >= 0 ? (siblings[afterIndex + 1]?.rank ?? null) : (siblings[0]?.rank ?? null);
  const rank = rankBetween(lower, upper, id);
  writeMove(doc, id, buildMove(newParentId, rank, move.hlc, ctx(actor)));
  return true;
}

/** True iff `candidateAncestorId` is `id` or a descendant of it (cycle guard for drag, ADR-0017). */
export function isDescendantOf(doc: Y.Doc, candidateId: string, ancestorId: string): boolean {
  if (candidateId === ancestorId) return true;
  const byId = new Map(allNodes(doc).map((n) => [n.id, n]));
  let cur = byId.get(candidateId);
  const seen = new Set<string>();
  while (cur) {
    if (cur.parentId === ancestorId) return true;
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    if (isRootParent(cur.parentId)) return false;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** Soft-delete the subtree root (ADR-0011). Descendants are filtered lazily, not tombstoned. */
export function deleteItem(doc: Y.Doc, id: string, actor: Actor): void {
  const del = readDeleted(itemsMap(doc).get(id)!);
  writeDeleted(doc, id, buildDelete(del.hlc, ctx(actor)));
}

/** Undo a delete (strictly-greater HLC beats the tombstone, ADR-0011). */
export function undeleteItem(doc: Y.Doc, id: string, actor: Actor): void {
  const del = readDeleted(itemsMap(doc).get(id)!);
  writeDeleted(doc, id, buildUndelete(del.hlc, ctx(actor)));
}

export function getContentText(doc: Y.Doc, id: string): string {
  const node = itemsMap(doc).get(id);
  return node ? nodeText(node, NODE_KEY.content) : '';
}

/** The parent id of an item (ROOT_PARENT_SENTINEL for the root), or undefined if absent. */
export function getParentId(doc: Y.Doc, id: string): string | undefined {
  const node = itemsMap(doc).get(id);
  const move = node && readMove(node);
  return move ? move.parentId : undefined;
}

/** True iff the item has at least one live child. */
export function hasChildren(doc: Y.Doc, id: string): boolean {
  return getChildren(doc, id).length > 0;
}

/**
 * Enter-split (ADR-0017): text after `offset` becomes a NEW SIBLING below `id`,
 * with a rank between `id` and its next sibling. `id` keeps the text before the
 * caret; the new item (caller-provided `newId`) receives the remainder. One
 * atomic transaction — the truncation and the insert never project half-applied.
 */
export function splitItem(doc: Y.Doc, id: string, offset: number, newId: string, actor: Actor): boolean {
  const node = itemsMap(doc).get(id);
  const move = node && readMove(node);
  if (!move) return false;
  const text = getContentYText(doc, id);
  const full = text?.toString() ?? '';
  const clamped = Math.max(0, Math.min(offset, full.length));
  const after = full.slice(clamped);
  Y.transact(doc, () => {
    if (text && after.length > 0) text.delete(clamped, text.length - clamped);
    insertItem(doc, newId, move.parentId, id, actor);
    const newText = getContentYText(doc, newId);
    if (newText && after.length > 0) newText.insert(0, after);
  });
  return true;
}


/** The item's content Y.Text, for a character-level collaborative text binding. */
export function getContentYText(doc: Y.Doc, id: string): Y.Text | undefined {
  return contentText(doc, id);
}

export function getIsCollapsed(doc: Y.Doc, id: string): boolean {
  return itemsMap(doc).get(id)?.get(NODE_KEY.isCollapsed) === true;
}

/** Collapse/expand toggles a plain LWW view flag — never structural (ADR-0017). */
export function setIsCollapsed(doc: Y.Doc, id: string, value: boolean): void {
  writeField(doc, id, NODE_KEY.isCollapsed, value);
}

export function getIsCompleted(doc: Y.Doc, id: string): boolean {
  return itemsMap(doc).get(id)?.get(NODE_KEY.isCompleted) === true;
}

/** Cmd/Ctrl-Enter: toggle task completion (ADR-0017). */
export function toggleCompleted(doc: Y.Doc, id: string): void {
  writeField(doc, id, NODE_KEY.isCompleted, !getIsCompleted(doc, id));
}

export function getItemType(doc: Y.Doc, id: string): ItemType {
  const t = itemsMap(doc).get(id)?.get(NODE_KEY.type);
  return isItemType(t) ? t : 'bullet';
}

export function setItemType(doc: Y.Doc, id: string, type: ItemType): void {
  writeField(doc, id, NODE_KEY.type, type);
}

/**
 * Backspace-at-start merge (ADR-0017): merge `id`'s text into the end of
 * `targetId`'s text, re-parent `id`'s children onto `targetId`, then tombstone
 * `id`. Returns false (no-op) if either item has no content Y.Text.
 */
export function mergeIntoPrevious(doc: Y.Doc, id: string, targetId: string, actor: Actor): boolean {
  const sourceText = getContentYText(doc, id);
  const targetText = getContentYText(doc, targetId);
  if (!sourceText || !targetText) return false;

  Y.transact(doc, () => {
    const insertAt = targetText.length;
    if (sourceText.length > 0) targetText.insert(insertAt, sourceText.toString());
  });

  // Re-parent id's live children onto targetId, appended after its existing children.
  const orphans = getChildren(doc, id);
  let lastRank = getChildren(doc, targetId).slice(-1)[0]?.rank ?? null;
  for (const child of orphans) {
    const childNode = itemsMap(doc).get(child.id);
    const childMove = childNode && readMove(childNode);
    if (!childMove) continue;
    const rank = rankBetween(lastRank, null, child.id);
    writeMove(doc, child.id, buildMove(targetId, rank, childMove.hlc, ctx(actor)));
    lastRank = rank;
  }

  deleteItem(doc, id, actor);
  return true;
}

export { ROOT_PARENT_SENTINEL };
