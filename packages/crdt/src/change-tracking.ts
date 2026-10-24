import type * as Y from 'yjs';
const listeners = new WeakMap<Y.Doc, Set<(id: string) => void>>();
export function beforeItemChange(doc: Y.Doc, id: string) {
  for (const listener of listeners.get(doc) ?? []) listener(id);
}
export function trackItemChanges(doc: Y.Doc, listener: (id: string) => void) {
  let set = listeners.get(doc);
  if (!set) {
    set = new Set();
    listeners.set(doc, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}
