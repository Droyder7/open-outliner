import * as Y from 'yjs';
import { itemsMap, readNodeSnapshot, writeMove, writeDeleted, writeField } from './yjs-node.js';
import type { ItemNodeSnapshot } from '@open-outliner/shared';
type Change = { id: string; before?: ItemNodeSnapshot; after?: ItemNodeSnapshot };
type Action = { kind: 'text' } | { kind: 'structure'; changes: Change[]; textSteps: number };
/** Local undo emits new structural intentions; it never rewinds a document snapshot. */
export function createOutlineHistory(doc: Y.Doc) {
  const manager = new Y.UndoManager([], {
    doc,
    trackedOrigins: new Set([null, 'structure']),
    captureTimeout: 0,
  });
  const undo: Action[] = [];
  const redo: Action[] = [];
  let replaying = false;
  let before: Map<string, ItemNodeSnapshot> | undefined;
  let textBefore = 0;
  const snapshot = () =>
    new Map(
      [...itemsMap(doc)].flatMap(([id, node]) => {
        const s = readNodeSnapshot(id, node);
        return s ? [[id, s] as const] : [];
      }),
    );
  const scopes = new Set<Y.Text>();
  const watchText = () => {
    for (const node of itemsMap(doc).values())
      for (const value of node.values())
        if (value instanceof Y.Text && !scopes.has(value)) {
          scopes.add(value);
          manager.addToScope(value);
        }
  };
  watchText();
  const begin = (transaction: Y.Transaction) => {
    if (!replaying && transaction.origin === 'structure') {
      before = snapshot();
      textBefore = manager.undoStack.length;
    }
  };
  const end = (transaction: Y.Transaction) => {
    watchText();
    if (!replaying && transaction.origin === 'structure' && before) {
      const after = snapshot();
      const changes: Change[] = [];
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(id),
          b = after.get(id);
        if (JSON.stringify(a) !== JSON.stringify(b))
          changes.push({ id, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
      }
      if (changes.length) {
        undo.push({ kind: 'structure', changes, textSteps: manager.undoStack.length - textBefore });
        redo.length = 0;
      }
      before = undefined;
    }
  };
  manager.on('stack-item-added', (event) => {
    if (!replaying && event.origin !== 'structure') {
      undo.push({ kind: 'text' });
      redo.length = 0;
    }
  });
  doc.on('beforeTransaction', begin);
  doc.on('afterTransaction', end);
  function apply(action: Action, side: 'before' | 'after') {
    replaying = true;
    try {
      if (action.kind === 'text') {
        if (side === 'before') manager.undo();
        else manager.redo();
        return;
      }
      doc.transact(() => {
        for (const change of action.changes) {
          const state = change[side];
          const node = itemsMap(doc).get(change.id);
          if (!node) continue;
          if (!state) {
            writeDeleted(doc, change.id, {
              isDeleted: true,
              hlc: { wallMs: 0, counter: 0, replicaId: '' },
            });
            continue;
          }
          if (
            !change.before ||
            !change.after ||
            JSON.stringify(change.before.move) !== JSON.stringify(change.after.move)
          )
            writeMove(doc, change.id, state.move);
          if (
            !change.before ||
            !change.after ||
            change.before.deleted.isDeleted !== change.after.deleted.isDeleted
          )
            writeDeleted(doc, change.id, state.deleted);
          if (change.before?.isCompleted !== change.after?.isCompleted)
            writeField(doc, change.id, 'isCompleted', state.isCompleted);
        }
      }, 'history');
      for (let i = 0; i < action.textSteps; i++) {
        if (side === 'before') manager.undo();
        else manager.redo();
      }
    } finally {
      replaying = false;
    }
  }
  return {
    undo() {
      const a = undo.pop();
      if (a) {
        apply(a, 'before');
        redo.push(a);
      }
    },
    redo() {
      const a = redo.pop();
      if (a) {
        apply(a, 'after');
        undo.push(a);
      }
    },
    stop() {
      doc.off('beforeTransaction', begin);
      doc.off('afterTransaction', end);
      manager.destroy();
    },
  };
}
