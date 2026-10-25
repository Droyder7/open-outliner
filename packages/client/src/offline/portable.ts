import * as Y from 'yjs';
import {
  deriveEffectiveTree,
  ROOT_PARENT_SENTINEL,
  ranksBetween,
  isItemType,
} from '@open-outliner/shared';
import {
  readAllSnapshots,
  getRootId,
  writeMove,
  writeContent,
  writeDeleted,
  writeField,
  itemsMap,
} from '@open-outliner/crdt';
export interface PortableItem {
  id: string;
  parentId: string | null;
  rank: string;
  type: string;
  content: string;
  note: string;
  isCompleted: boolean;
  deleted?: boolean;
}
export interface PortableDocument {
  format: 'open-outliner';
  version: 2;
  title: string;
  items: PortableItem[];
}
export function portableDocument(doc: Y.Doc, includeTrash = false): PortableDocument {
  const root = String(doc.getMap('meta').get('rootId') ?? getRootId(doc) ?? '');
  const nodes = readAllSnapshots(doc);
  const tree = deriveEffectiveTree(
    nodes.map((n) => ({ id: n.id, parentId: n.move.parentId, isDeleted: n.deleted.isDeleted })),
    root,
  );
  return {
    format: 'open-outliner',
    version: 2,
    title: String(doc.getMap('meta').get('title') ?? 'Untitled'),
    items: nodes
      .filter((n) => includeTrash || !tree.deleted.has(n.id))
      .map((n) => ({
        id: n.id,
        parentId: n.id === root ? null : (tree.parents.get(n.id) ?? root),
        rank: n.move.rank,
        type: n.type,
        content: n.content,
        note: n.note ?? '',
        isCompleted: n.isCompleted,
        ...(includeTrash ? { deleted: n.deleted.isDeleted } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function validatePortable(input: unknown): PortableDocument {
  if (!input || typeof input !== 'object') throw new Error('Expected an outline JSON document');
  const value = input as PortableDocument;
  if (
    value.format !== 'open-outliner' ||
    value.version !== 2 ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 50000
  )
    throw new Error('Unsupported or oversized outline document');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id) ||
      !(item.parentId === null || typeof item.parentId === 'string') ||
      typeof item.rank !== 'string' ||
      !isItemType(item.type) ||
      typeof item.content !== 'string' ||
      typeof item.note !== 'string' ||
      typeof item.isCompleted !== 'boolean' ||
      (item.deleted !== undefined && typeof item.deleted !== 'boolean')
    )
      throw new Error('Invalid or duplicate outline item');
    ids.add(item.id);
  }
  const roots = value.items.filter((i) => i.parentId === null);
  if (roots.length !== 1) throw new Error('Expected exactly one root');
  const tree = deriveEffectiveTree(
    value.items.map((i) => ({
      id: i.id,
      parentId: i.parentId ?? ROOT_PARENT_SENTINEL,
      isDeleted: false,
    })),
    roots[0]!.id,
  );
  if (tree.recovered.size) throw new Error('Import contains a cycle or missing parent');
  return value;
}
export function instantiatePortable(input: unknown, documentId: string): Y.Doc {
  const value = validatePortable(input);
  const root = value.items.find((i) => i.parentId === null)!;
  const ids = new Map(
    value.items.map((i) => [i.id, i === root ? documentId : crypto.randomUUID()]),
  );
  const ranks = new Map<string, string>();
  const groups = new Map<string | null, PortableItem[]>();
  for (const item of value.items) {
    const siblings = groups.get(item.parentId) ?? [];
    siblings.push(item);
    groups.set(item.parentId, siblings);
  }
  for (const siblings of groups.values()) {
    siblings.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
    const keys = ranksBetween(null, null, siblings.length);
    siblings.forEach((item, i) => ranks.set(item.id, keys[i]!));
  }
  const doc = new Y.Doc();
  doc.getMap('meta').set('schemaVersion', 2);
  doc.getMap('meta').set('rootId', documentId);
  doc.getMap('meta').set('title', value.title);
  doc.transact(() => {
    for (const item of value.items) {
      const id = ids.get(item.id)!;
      writeMove(doc, id, {
        parentId: item.parentId === null ? ROOT_PARENT_SENTINEL : ids.get(item.parentId)!,
        rank: ranks.get(item.id)!,
        hlc: { wallMs: Date.now(), counter: 0, replicaId: 'import' },
      });
      writeContent(doc, id, item.content);
      itemsMap(doc).get(id)!.set('note', new Y.Text(item.note));
      writeField(doc, id, 'type', item.type);
      writeField(doc, id, 'isCompleted', item.isCompleted);
      if (item.deleted)
        writeDeleted(doc, id, { isDeleted: true, hlc: { wallMs: 0, counter: 0, replicaId: '' } });
    }
  }, 'import');
  return doc;
}
export function markdown(value: PortableDocument): string {
  const root = value.items.find((i) => i.parentId === null)!;
  const groups = new Map<string, PortableItem[]>();
  for (const item of value.items)
    if (item.parentId !== null) {
      const siblings = groups.get(item.parentId) ?? [];
      siblings.push(item);
      groups.set(item.parentId, siblings);
    }
  for (const children of groups.values())
    children.sort((a, b) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id.localeCompare(b.id),
    );
  const lines = [`# ${value.title}`, ''];
  const stack = (groups.get(root.id) ?? []).map((item) => ({ item, depth: 0 })).reverse();
  while (stack.length) {
    const { item, depth } = stack.pop()!;
    lines.push(
      `${'  '.repeat(depth)}- ${item.isCompleted ? '[x] ' : item.type === 'task' ? '[ ] ' : ''}${item.content.replace(/\n/g, ' ')}`,
    );
    if (item.note) lines.push(`${'  '.repeat(depth + 1)}> ${item.note.replace(/\n/g, ' ')}`);
    const children = groups.get(item.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ item: children[i]!, depth: depth + 1 });
  }
  return lines.join('\n') + '\n';
}
