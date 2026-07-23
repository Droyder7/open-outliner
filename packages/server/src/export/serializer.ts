import { randomUUID } from 'node:crypto';
import type { ItemRow } from '../db/items-repo.js';
import type { ExportedDocument, ExportedItem } from '@open-outliner/shared';
import type { Db } from '../db/db.js';
import { rankBetween } from '@open-outliner/shared';
import { createDocumentWithRoot } from '../db/tenancy-repo.js';

/**
 * Export serializers (ADR-0016): Markdown (human-readable, lossy) and JSON
 * (full-fidelity round-trip). Both emit siblings in deterministic (rank, id)
 * order and exclude tombstoned items (deleted_at IS NOT NULL is already
 * filtered by getLiveItems upstream).
 *
 * V1 content is plain text (ADR-0018) so Markdown serialization is lossless
 * for content; item type maps to the nearest Markdown construct.
 */

function buildTree(rows: ItemRow[]): Map<string | null, ItemRow[]> {
  const byParent = new Map<string | null, ItemRow[]>();
  for (const row of rows) {
    const key = row.parent_id ?? null;
    const bucket = byParent.get(key) ?? [];
    bucket.push(row);
    byParent.set(key, bucket);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => {
      if (a.rank < b.rank) return -1;
      if (a.rank > b.rank) return 1;
      return a.id < b.id ? -1 : 1;
    });
  }
  return byParent;
}

function itemToMarkdown(row: ItemRow, depth: number): string {
  const indent = '  '.repeat(depth);
  const content = row.content || '(empty)';
  switch (row.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(depth + 1, 6))} ${content}`;
    case 'task':
      return `${indent}- [${row.is_completed ? 'x' : ' '}] ${content}`;
    case 'divider':
      return `${indent}---`;
    default:
      return `${indent}- ${content}`;
  }
}

function renderMarkdownNode(
  id: string,
  byParent: Map<string | null, ItemRow[]>,
  rowById: Map<string, ItemRow>,
  depth: number,
  lines: string[],
): void {
  const row = rowById.get(id);
  if (!row) return;
  lines.push(itemToMarkdown(row, depth));
  if (row.note) lines.push(`${'  '.repeat(depth + 1)}> ${row.note}`);
  const children = byParent.get(id) ?? [];
  for (const child of children) {
    renderMarkdownNode(child.id, byParent, rowById, depth + 1, lines);
  }
}

export function serializeMarkdown(rows: ItemRow[]): string {
  const byParent = buildTree(rows);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const roots = byParent.get(null) ?? [];
  const lines: string[] = [];
  for (const root of roots) {
    renderMarkdownNode(root.id, byParent, rowById, 0, lines);
  }
  return lines.join('\n');
}

export function serializeJson(_documentId: string, rows: ItemRow[]): string {
  const byParent = buildTree(rows);

  const orderedItems: ExportedItem[] = [];
  function visit(parentId: string | null): void {
    const children = byParent.get(parentId) ?? [];
    for (const row of children) {
      orderedItems.push({
        id: row.id,
        parentId: row.parent_id,
        rank: row.rank,
        type: row.type,
        content: row.content,
        note: row.note,
        isCompleted: row.is_completed,
        isCollapsed: row.is_collapsed,
      });
      visit(row.id);
    }
  }
  visit(null);

  const doc: ExportedDocument = {
    version: 1,
    exportedAt: new Date().toISOString(),
    items: orderedItems,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Import a round-trip JSON export into a fresh document in the given workspace.
 * Fresh item ids are assigned to avoid collisions; hierarchy and (rank, id) order
 * are preserved. The synthetic root of the new document is the one item with
 * parentId === null (the original root), or a new root if multiple roots exist.
 */
export async function importDocument(
  db: Db,
  workspaceId: string,
  title: string,
  data: ExportedDocument,
): Promise<{ documentId: string; rootItemId: string }> {
  const { documentId, rootItemId } = await createDocumentWithRoot(db, workspaceId, title);

  const idMap = new Map<string | null, string>();
  idMap.set(null, null as unknown as string);

  const roots = data.items.filter((i) => i.parentId === null);
  const nonRoots = data.items.filter((i) => i.parentId !== null);

  for (const item of roots) {
    idMap.set(item.id, rootItemId);
  }

  for (const item of nonRoots) {
    const newId = randomUUID();
    idMap.set(item.id, newId);
  }

  for (const item of nonRoots) {
    const newId = idMap.get(item.id)!;
    const newParentId = item.parentId ? (idMap.get(item.parentId) ?? null) : null;

    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content, note, is_completed, is_collapsed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        newId,
        documentId,
        newParentId,
        item.rank || rankBetween(null, null),
        item.type,
        item.content,
        item.note ?? null,
        item.isCompleted,
        item.isCollapsed,
      ],
    );
  }

  if (roots.length === 1 && roots[0]) {
    const srcRoot = roots[0];
    await db.query(
      `UPDATE items SET type = $1, content = $2, note = $3, is_completed = $4, is_collapsed = $5
        WHERE id = $6 AND document_id = $7`,
      [
        srcRoot.type,
        srcRoot.content,
        srcRoot.note ?? null,
        srcRoot.isCompleted,
        srcRoot.isCollapsed,
        rootItemId,
        documentId,
      ],
    );
  }

  return { documentId, rootItemId };
}
