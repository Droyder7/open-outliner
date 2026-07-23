import { withDocumentLock } from '../db/db.js';
import type { Db } from '../db/db.js';
import { softDeleteAttachmentsForItem } from '../db/attachments-repo.js';
import {
  getPendingS3Deletions,
  clearS3Key,
  gcBacklogCount,
} from '../db/attachments-repo.js';
import type { S3Service } from '../storage/s3.js';

/**
 * Tombstone-aware GC worker (Phase 9 / ADR-0006).
 *
 * Delete path:
 * 1. The CRDT `deleted` register on the subtree root is the tombstone (set by
 *    the client via ADR-0011). The materializer projects it to `items.deleted_at`.
 * 2. This worker hard-deletes rows bottom-up (leaves first) AFTER the
 *    replica-acknowledgement retention window, so offline replicas that synced
 *    past the tombstone can no longer revive the row.
 * 3. Attachment rows are soft-deleted BEFORE the item row is hard-deleted
 *    (the RESTRICT FK requires it); S3 objects are removed after their own
 *    retention window (deferred GC — avoids the offline-undo race).
 *
 * All work runs under the per-document advisory lock shared with the projector
 * and compaction so they cannot interleave for the same document.
 */

export interface GcWorker {
  /** Run one GC pass across all documents. Returns count of hard-deleted items. */
  run(): Promise<number>;
  /** Return the current attachment S3 GC backlog count (for metrics). */
  backlogCount(): Promise<number>;
}

export interface GcConfig {
  /** Minimum age of deleted_at before a row may be hard-deleted (ms). Default: 7 days. */
  retentionMs?: number;
  /** How many items to hard-delete per document per pass to bound lock hold time. */
  batchSize?: number;
}

async function getStaleDocuments(db: Db, cutoff: Date): Promise<string[]> {
  const res = await db.query<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM items
      WHERE deleted_at IS NOT NULL AND deleted_at < $1
      LIMIT 200`,
    [cutoff],
  );
  return res.rows.map((r) => r.document_id);
}

/**
 * Bottom-up delete: find leaf tombstones (no live children) under the document
 * and hard-delete them one level at a time until none remain or the batch limit
 * is reached.
 */
async function gcDocument(
  db: Db,
  documentId: string,
  cutoff: Date,
  batchSize: number,
  _s3?: S3Service,
): Promise<number> {
  return withDocumentLock(db, documentId, async (tx) => {
    // Tombstoned leaves: items with deleted_at before cutoff that have NO live
    // children (a child pointing at them). Bottom-up ensures RESTRICT FK is never
    // violated.
    const res = await tx.query<{ id: string }>(
      `SELECT i.id FROM items i
        WHERE i.document_id = $1
          AND i.deleted_at IS NOT NULL
          AND i.deleted_at < $2
          AND NOT EXISTS (
            SELECT 1 FROM items c
             WHERE c.parent_id = i.id AND c.document_id = $1
          )
        ORDER BY i.deleted_at
        LIMIT $3`,
      [documentId, cutoff, batchSize],
    );

    let deleted = 0;
    for (const row of res.rows) {
      await softDeleteAttachmentsForItem(tx, documentId, row.id);
      await tx.query(`DELETE FROM items WHERE id = $1 AND document_id = $2`, [
        row.id,
        documentId,
      ]);
      deleted++;
    }
    return deleted;
  });
}

async function gcS3Objects(db: Db, cutoff: Date, s3: S3Service): Promise<void> {
  const pending = await getPendingS3Deletions(db, cutoff);
  for (const att of pending) {
    try {
      await s3.deleteObject(att.s3_key);
      await clearS3Key(db, att.id);
    } catch {
      // Best-effort: if S3 delete fails, the row retains its s3_key and will be
      // retried on the next GC pass.
    }
  }
}

export function createGcWorker(
  db: Db,
  config: GcConfig = {},
  s3?: S3Service,
): GcWorker {
  const retentionMs = config.retentionMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const batchSize = config.batchSize ?? 500;

  return {
    async run() {
      const cutoff = new Date(Date.now() - retentionMs);
      const docs = await getStaleDocuments(db, cutoff);
      let total = 0;
      for (const documentId of docs) {
        try {
          total += await gcDocument(db, documentId, cutoff, batchSize, s3);
        } catch {
          // Log and continue; don't let one document stall the whole pass.
        }
      }
      if (s3) {
        await gcS3Objects(db, cutoff, s3);
      }
      return total;
    },

    async backlogCount() {
      return gcBacklogCount(db);
    },
  };
}
