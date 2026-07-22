import * as Y from 'yjs';
import {
  ITEMS_MAP,
  NODE_KEY,
  MOVE_KEY,
  DELETED_KEY,
  HLC_KEY,
  ROOT_PARENT_SENTINEL,
  isItemType,
  type Hlc,
  type ItemType,
  type MoveRegister,
  type DeletedRegister,
  type ItemNodeSnapshot,
} from '@open-outliner/shared';

/**
 * Yjs binding for the item-node schema (ADR-0008/0010/0011, yjs-schema.ts).
 *
 * The plain shapes and rules live in `@open-outliner/shared` (dependency-free,
 * unit-tested). This module is the ONE place that translates them to/from live
 * `Y.Map`/`Y.Text` structures, so the atomic-move discipline (ADR-0010 — the
 * whole `move` value is replaced in a single transaction, never a bare
 * `set('rank')`) is enforced in code, not by convention.
 */

export function itemsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(ITEMS_MAP) as Y.Map<Y.Map<unknown>>;
}

function readHlc(map: Y.Map<unknown> | undefined): Hlc | undefined {
  if (!map) return undefined;
  const wallMs = map.get(HLC_KEY.wallMs);
  const counter = map.get(HLC_KEY.counter);
  const replicaId = map.get(HLC_KEY.replicaId);
  if (typeof wallMs !== 'number' || typeof counter !== 'number' || typeof replicaId !== 'string') {
    return undefined;
  }
  return { wallMs, counter, replicaId };
}

function newHlcMap(hlc: Hlc): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set(HLC_KEY.wallMs, hlc.wallMs);
  m.set(HLC_KEY.counter, hlc.counter);
  m.set(HLC_KEY.replicaId, hlc.replicaId);
  return m;
}

export function readMove(node: Y.Map<unknown>): MoveRegister | undefined {
  const move = node.get(NODE_KEY.move) as Y.Map<unknown> | undefined;
  if (!move) return undefined;
  const parentId = move.get(MOVE_KEY.parentId);
  const rank = move.get(MOVE_KEY.rank);
  const hlc = readHlc(move.get(MOVE_KEY.hlc) as Y.Map<unknown> | undefined);
  if (typeof parentId !== 'string' || typeof rank !== 'string' || !hlc) return undefined;
  return { parentId, rank, hlc };
}

export function readDeleted(node: Y.Map<unknown>): DeletedRegister {
  const del = node.get(NODE_KEY.deleted) as Y.Map<unknown> | undefined;
  if (!del) return { isDeleted: false, hlc: { wallMs: 0, counter: 0, replicaId: '' } };
  const isDeleted = del.get(DELETED_KEY.isDeleted);
  const hlc = readHlc(del.get(DELETED_KEY.hlc) as Y.Map<unknown> | undefined);
  return {
    isDeleted: isDeleted === true,
    hlc: hlc ?? { wallMs: 0, counter: 0, replicaId: '' },
  };
}

function readType(node: Y.Map<unknown>): ItemType {
  const t = node.get(NODE_KEY.type);
  return isItemType(t) ? t : 'bullet';
}

function readText(node: Y.Map<unknown>, key: string): string {
  const t = node.get(key);
  if (t instanceof Y.Text) return t.toString();
  if (typeof t === 'string') return t;
  return '';
}

/** Read one item node into the plain, plane-complete snapshot the projector uses. */
export function readNodeSnapshot(id: string, node: Y.Map<unknown>): ItemNodeSnapshot | undefined {
  const move = readMove(node);
  if (!move) return undefined; // a node without a move register is not projectable
  const noteText = node.get(NODE_KEY.note);
  const snapshot: ItemNodeSnapshot = {
    id,
    move,
    deleted: readDeleted(node),
    type: readType(node),
    content: readText(node, NODE_KEY.content),
    isCompleted: node.get(NODE_KEY.isCompleted) === true,
    isCollapsed: node.get(NODE_KEY.isCollapsed) === true,
    ...(noteText !== undefined ? { note: readText(node, NODE_KEY.note) } : {}),
  };
  return snapshot;
}

/** Read every projectable item node from the document. */
export function readAllSnapshots(doc: Y.Doc): ItemNodeSnapshot[] {
  const out: ItemNodeSnapshot[] = [];
  for (const [id, node] of itemsMap(doc)) {
    const snap = readNodeSnapshot(id, node);
    if (snap) out.push(snap);
  }
  return out;
}

// --- Writers (used by tests, cycle repair, and the Phase 4 editor binding) ---

/**
 * Create or replace an item node's atomic `move` register in ONE transaction
 * (ADR-0010). Never call `move.set('rank', …)` in isolation — the whole value is
 * replaced so a concurrent merge can never produce a torn `{parentId, rank}`.
 */
export function writeMove(doc: Y.Doc, id: string, move: MoveRegister): void {
  Y.transact(doc, () => {
    const items = itemsMap(doc);
    let node = items.get(id);
    if (!node) {
      node = new Y.Map<unknown>();
      items.set(id, node);
    }
    const moveMap = new Y.Map<unknown>();
    moveMap.set(MOVE_KEY.parentId, move.parentId);
    moveMap.set(MOVE_KEY.rank, move.rank);
    moveMap.set(MOVE_KEY.hlc, newHlcMap(move.hlc));
    node.set(NODE_KEY.move, moveMap);
  });
}

/** Set an item node's `deleted` register in one transaction (ADR-0011). */
export function writeDeleted(doc: Y.Doc, id: string, del: DeletedRegister): void {
  Y.transact(doc, () => {
    const node = itemsMap(doc).get(id);
    if (!node) return;
    const delMap = new Y.Map<unknown>();
    delMap.set(DELETED_KEY.isDeleted, del.isDeleted);
    delMap.set(DELETED_KEY.hlc, newHlcMap(del.hlc));
    node.set(NODE_KEY.deleted, delMap);
  });
}

/** Set an item node's plain-text content (Y.Text) — replaces the whole text. */
export function writeContent(doc: Y.Doc, id: string, content: string): void {
  Y.transact(doc, () => {
    const node = itemsMap(doc).get(id);
    if (!node) return;
    let text = node.get(NODE_KEY.content);
    if (!(text instanceof Y.Text)) {
      text = new Y.Text();
      node.set(NODE_KEY.content, text);
    }
    const t = text as Y.Text;
    if (t.length > 0) t.delete(0, t.length);
    if (content.length > 0) t.insert(0, content);
  });
}

/** Set a plain LWW field (type/isCompleted/isCollapsed). */
export function writeField(
  doc: Y.Doc,
  id: string,
  key: (typeof NODE_KEY)[keyof typeof NODE_KEY],
  value: unknown,
): void {
  Y.transact(doc, () => {
    const node = itemsMap(doc).get(id);
    if (node) node.set(key, value);
  });
}

export { ROOT_PARENT_SENTINEL };
