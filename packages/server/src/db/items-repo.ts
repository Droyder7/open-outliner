import type { ItemType } from '@open-outliner/shared';
import type { Db, TxClient } from './db.js';

/**
 * Typed row shapes and query helpers for the `items` projection and tenancy
 * tables. Every read leads with `document_id` (tenancy rule,
 * security-and-multitenancy.md). Structural columns (`parent_id`, `rank`) are
 * written ONLY by the materializer (yjs-projection.md hard rule).
 */

export interface ItemRow {
  id: string;
  document_id: string;
  parent_id: string | null;
  rank: string;
  type: ItemType;
  content: string;
  note: string | null;
  is_completed: boolean;
  is_collapsed: boolean;
  version: number;
  deleted_at: Date | null;
}

/** A single item's projected structural state, as the materializer writes it. */
export interface ProjectedItem {
  id: string;
  parentId: string | null; // null = synthetic root
  rank: string;
  type: ItemType;
  content: string;
  note: string | null;
  isCompleted: boolean;
  isCollapsed: boolean;
  deleted: boolean;
}

/** Read all live (non-tombstoned) items for a document, in no particular order. */
export async function getLiveItems(db: Db, documentId: string): Promise<ItemRow[]> {
  const res = await db.query<ItemRow>(
    `SELECT id, document_id, parent_id, rank, type, content, note,
            is_completed, is_collapsed, version, deleted_at
       FROM items
      WHERE document_id = $1 AND deleted_at IS NULL`,
    [documentId],
  );
  return res.rows;
}

/** Read every item row for a document, including tombstones (for the materializer diff). */
export async function getAllItemRows(tx: TxClient, documentId: string): Promise<ItemRow[]> {
  const res = await tx.query<ItemRow>(
    `SELECT id, document_id, parent_id, rank, type, content, note,
            is_completed, is_collapsed, version, deleted_at
       FROM items
      WHERE document_id = $1`,
    [documentId],
  );
  return res.rows;
}

/**
 * Upsert one projected item (materializer path). Reads the atomic `move`
 * register as a unit upstream, so `parent_id` and `rank` always come from the
 * same winning move (ADR-0010). `deleted_at` is set to the server clock the
 * first time `deleted` flips true and cleared on undo (ADR-0011). `version` is
 * bumped as the optimistic-concurrency counter.
 */
export async function upsertProjectedItem(
  tx: TxClient,
  documentId: string,
  item: ProjectedItem,
): Promise<void> {
  await tx.query(
    `INSERT INTO items
       (id, document_id, parent_id, rank, type, content, note,
        is_completed, is_collapsed, deleted_at, version, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        CASE WHEN $10 THEN now() ELSE NULL END, 1, now())
     ON CONFLICT (id) DO UPDATE SET
        parent_id    = EXCLUDED.parent_id,
        rank         = EXCLUDED.rank,
        type         = EXCLUDED.type,
        content      = EXCLUDED.content,
        note         = EXCLUDED.note,
        is_completed = EXCLUDED.is_completed,
        is_collapsed = EXCLUDED.is_collapsed,
        -- Flip deleted_at only on transition: set when tombstoning for the first
        -- time, clear on undo, otherwise preserve the existing timestamp.
        deleted_at   = CASE
                         WHEN $10 AND items.deleted_at IS NULL THEN now()
                         WHEN NOT $10 THEN NULL
                         ELSE items.deleted_at
                       END,
        version      = items.version + 1,
        updated_at   = now()`,
    [
      item.id,
      documentId,
      item.parentId,
      item.rank,
      item.type,
      item.content,
      item.note,
      item.isCompleted,
      item.isCollapsed,
      item.deleted,
    ],
  );
}

/**
 * Read a bounded-depth subtree rooted at `parentId` (or the document's true
 * roots when `parentId` is null) — the API's **load-on-expand** read
 * (api-and-write-path.md): callers page a large outline in by expanding
 * nodes rather than fetching the whole document in one response. `depth`
 * counts levels below `parentId` inclusive of its direct children (depth=1 ==
 * children only, depth=2 == children + grandchildren, ...).
 */
export async function getSubtree(
  db: Db,
  documentId: string,
  parentId: string | null,
  depth: number,
): Promise<ItemRow[]> {
  const res = await db.query<ItemRow>(
    `WITH RECURSIVE subtree AS (
       SELECT *, 0 AS level FROM items
        WHERE document_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
       UNION ALL
       SELECT i.*, s.level + 1 FROM items i
         JOIN subtree s ON i.parent_id = s.id
        WHERE i.document_id = $1 AND i.deleted_at IS NULL AND s.level + 1 <= $3
     )
     SELECT id, document_id, parent_id, rank, type, content, note,
            is_completed, is_collapsed, version, deleted_at
       FROM subtree
      ORDER BY level, rank, id`,
    [documentId, parentId, depth],
  );
  return res.rows;
}

/** Pure metadata update via the API path with optimistic concurrency (version). */
export interface MetadataUpdate {
  note?: string | null;
  color?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Apply a pure-metadata UpdateItem (api-and-write-path.md). Returns the new row
 * if the version matched, or null on a version conflict (caller maps to
 * `version_conflict`). Never touches structural columns.
 */
export async function updateItemMetadata(
  db: Db,
  documentId: string,
  id: string,
  expectedVersion: number,
  fields: MetadataUpdate,
): Promise<ItemRow | null> {
  const res = await db.query<ItemRow>(
    `UPDATE items SET
        note     = COALESCE($4, note),
        color    = COALESCE($5, color),
        metadata = COALESCE($6, metadata),
        version  = version + 1,
        updated_at = now()
      WHERE document_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL
      RETURNING id, document_id, parent_id, rank, type, content, note,
                is_completed, is_collapsed, version, deleted_at`,
    [
      documentId,
      id,
      expectedVersion,
      fields.note ?? null,
      fields.color ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ],
  );
  return res.rows[0] ?? null;
}

/** Look up one live item by id, for distinguishing not-found from a version conflict. */
export async function getItemById(db: Db, documentId: string, id: string): Promise<ItemRow | null> {
  const res = await db.query<ItemRow>(
    `SELECT id, document_id, parent_id, rank, type, content, note,
            is_completed, is_collapsed, version, deleted_at
       FROM items
      WHERE document_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [documentId, id],
  );
  return res.rows[0] ?? null;
}
