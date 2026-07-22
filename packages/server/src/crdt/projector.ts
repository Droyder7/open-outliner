import * as Y from 'yjs';
import type { CycleRepair } from '@open-outliner/shared';
import { MOVE_KEY, HLC_KEY, NODE_KEY } from '@open-outliner/shared';
import type { Db, TxClient } from '../db/db.js';
import { withDocumentLock } from '../db/db.js';
import { upsertProjectedItem, getAllItemRows, type ProjectedItem } from '../db/items-repo.js';
import type { YjsStore } from './yjs-store.js';
import { readAllSnapshots, itemsMap } from '@open-outliner/crdt';
import { projectSnapshots } from './materialize.js';

/**
 * The materializer: projects merged CRDT state into `items`, with the monotonic
 * `projected_rev` guard and catch-up sweep (ADR-0013, yjs-projection.md).
 *
 * Every pass runs under the per-document advisory lock and applies ONLY if it
 * advances the revision — a delayed older callback that arrives after a newer one
 * sees `source_rev <= projected_rev` and no-ops instead of overwriting stale
 * state. The revision advance commits in the same transaction as the upserts.
 */

export interface Projector {
  /** Project one document if it is behind. Returns true if a pass ran. */
  projectDocument(documentId: string): Promise<boolean>;
  /** Re-project every document whose projected_rev < source_rev (catch-up sweep). */
  sweep(): Promise<number>;
}

export interface ProjectorDeps {
  db: Db;
  store: YjsStore;
  /** The server's Yjs replica id, stamped on emitted cycle-repair moves. */
  replicaId: string;
  /** Physical clock (injectable for tests). */
  now?: () => number;
  log?: (msg: string) => void;
}

async function readRevisions(
  tx: TxClient,
  documentId: string,
): Promise<{ sourceRev: number; projectedRev: number }> {
  const res = await tx.query<{ source_rev: string; projected_rev: string }>(
    `SELECT source_rev, projected_rev FROM document_projection WHERE document_id = $1 FOR UPDATE`,
    [documentId],
  );
  const row = res.rows[0];
  if (!row) return { sourceRev: 0, projectedRev: 0 };
  return {
    sourceRev: Number.parseInt(row.source_rev, 10),
    projectedRev: Number.parseInt(row.projected_rev, 10),
  };
}

/** Apply a cycle repair as an ordinary atomic `move` write into the live doc (ADR-0012). */
function applyRepair(doc: Y.Doc, repair: CycleRepair): void {
  Y.transact(doc, () => {
    const node = itemsMap(doc).get(repair.itemId);
    if (!node) return;
    const moveMap = new Y.Map<unknown>();
    moveMap.set(MOVE_KEY.parentId, repair.newParentId);
    moveMap.set(MOVE_KEY.rank, repair.newRank);
    const hlcMap = new Y.Map<unknown>();
    hlcMap.set(HLC_KEY.wallMs, repair.newHlc.wallMs);
    hlcMap.set(HLC_KEY.counter, repair.newHlc.counter);
    hlcMap.set(HLC_KEY.replicaId, repair.newHlc.replicaId);
    moveMap.set(MOVE_KEY.hlc, hlcMap);
    node.set(NODE_KEY.move, moveMap);
  });
}

/**
 * Order rows so every row appears after its parent (parents/roots first), which
 * keeps the same-document parent FK satisfied during upsert. Cycles are already
 * repaired before this runs, so the live structure is a forest; any row whose
 * parent is not in the set (e.g. a not-yet-projected parent) is appended last.
 */
function topologicalOrder(rows: readonly ProjectedItem[]): ProjectedItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const emitted = new Set<string>();
  const out: ProjectedItem[] = [];

  function visit(row: ProjectedItem, guard: Set<string>): void {
    if (emitted.has(row.id) || guard.has(row.id)) return;
    guard.add(row.id);
    if (row.parentId !== null) {
      const parent = byId.get(row.parentId);
      if (parent) visit(parent, guard);
    }
    if (!emitted.has(row.id)) {
      emitted.add(row.id);
      out.push(row);
    }
  }

  for (const row of rows) visit(row, new Set());
  return out;
}

export function createProjector(deps: ProjectorDeps): Projector {
  const { db, store, replicaId } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  async function projectDocument(documentId: string): Promise<boolean> {
    // Load merged state OUTSIDE the lock (read-only replay); the lock only guards
    // the revision compare + upserts so passes serialize but reads don't block.
    const doc = await store.loadDocument(documentId);
    try {
      // Detect cycles FIRST (ADR-0012). A cyclic projection can never satisfy the
      // same-document parent FK in any upsert order, so we must repair the CRDT
      // plane and re-project — never attempt to upsert the cyclic state and never
      // veto at the projector. Emit repairs, persist, and recurse.
      const preSnapshots = readAllSnapshots(doc);
      const { repairs } = projectSnapshots(preSnapshots, now(), replicaId);
      if (repairs.length > 0) {
        for (const repair of repairs) applyRepair(doc, repair);
        await store.storeUpdate(documentId, Y.encodeStateAsUpdate(doc));
        log(`emitted ${repairs.length} cycle repair(s) for ${documentId}`);
        return projectDocument(documentId); // re-project the now-acyclic state
      }

      return await withDocumentLock(db, documentId, async (tx) => {
        const { sourceRev, projectedRev } = await readRevisions(tx, documentId);
        // Monotonic guard: only project if this pass advances the revision.
        if (sourceRev <= projectedRev) return false;

        const snapshots = readAllSnapshots(doc);
        const { rows } = projectSnapshots(snapshots, now(), replicaId);

        // Upsert in topological order (each row after its parent) so the
        // same-document parent FK is always satisfied. Roots (parent null) first.
        for (const row of topologicalOrder(rows)) {
          await upsertProjectedItem(tx, documentId, row);
        }

        // Tombstone rows present in items but absent from the merged CRDT: mark
        // deleted (never a raw DELETE — GC hard-deletes bottom-up later, ADR-0006).
        const present = new Set(rows.map((r) => r.id));
        const existing = await getAllItemRows(tx, documentId);
        for (const e of existing) {
          if (!present.has(e.id) && e.deleted_at === null) {
            await tx.query(
              `UPDATE items SET deleted_at = now(), version = version + 1, updated_at = now()
                WHERE id = $1 AND document_id = $2`,
              [e.id, documentId],
            );
          }
        }

        // Advance projected_rev in the SAME transaction as the upserts.
        await tx.query(
          `UPDATE document_projection SET projected_rev = $2, updated_at = now()
            WHERE document_id = $1`,
          [documentId, sourceRev],
        );
        return true;
      });
    } finally {
      doc.destroy();
    }
  }

  async function sweep(): Promise<number> {
    const res = await db.query<{ document_id: string }>(
      `SELECT document_id FROM document_projection WHERE projected_rev < source_rev`,
    );
    let count = 0;
    for (const row of res.rows) {
      try {
        if (await projectDocument(row.document_id)) count++;
      } catch (err) {
        log(
          `sweep failed for ${row.document_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return count;
  }

  return { projectDocument, sweep };
}
