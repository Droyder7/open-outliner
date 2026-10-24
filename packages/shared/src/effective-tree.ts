import { ROOT_PARENT_SENTINEL } from './yjs-schema.js';
export interface TreeNode {
  id: string;
  parentId: string;
  isDeleted: boolean;
}
/** Pure interpretation: raw placements are preserved; cycles/orphans stay visible. */
export function deriveEffectiveTree(nodes: readonly TreeNode[], rootId: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map(
    nodes.map((n) => [n.id, n.id === rootId ? ROOT_PARENT_SENTINEL : n.parentId]),
  );
  const recovered = new Set<string>();
  const done = new Set<string>([rootId]);
  for (const node of nodes) {
    if (node.id === rootId) continue;
    if (!byId.has(node.parentId) || node.parentId === ROOT_PARENT_SENTINEL) {
      parents.set(node.id, rootId);
      recovered.add(node.id);
    }
  }
  for (const node of nodes) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let id = node.id;
    while (id !== rootId && !done.has(id)) {
      const position = positions.get(id);
      if (position !== undefined) {
        const freed = path.slice(position).sort()[0]!;
        parents.set(freed, rootId);
        recovered.add(freed);
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = parents.get(id) ?? rootId;
    }
    for (const visited of path) done.add(visited);
  }
  const deleted = new Set<string>();
  const known = new Set<string>([rootId]);
  for (const node of nodes) {
    if (known.has(node.id)) continue;
    const path: string[] = [];
    let id = node.id;
    while (id !== rootId && !known.has(id)) {
      path.push(id);
      id = parents.get(id) ?? rootId;
    }
    let hidden = deleted.has(id);
    for (let i = path.length - 1; i >= 0; i--) {
      const child = path[i]!;
      hidden = hidden || Boolean(byId.get(child)?.isDeleted);
      known.add(child);
      if (hidden) deleted.add(child);
    }
  }
  return { parents, recovered, deleted };
}
