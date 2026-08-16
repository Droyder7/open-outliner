import { withDocumentLock } from '../db/db.js';
import type { Db } from '../db/db.js';
import { softDeleteAttachmentsForItem } from '../db/attachments-repo.js';
import {
  getPendingS3Deletions,
  clearS3Key,
  gcBacklogCount,
} from '../db/attachments-repo.js';
import { pruneStaleReplicas } from '../db/replica-sync-repo.js';
import type { S3Service } from '../storage/s3.js';
import type { RegisteredConnection } from '../crdt/connections.js';

/**
 * Tombstone-aware GC worker (Phase 9 / ADR-0006).
 *
 * Delete path:
 * 1. The CRDT `deleted` register on the subtree root is the tombstone (set by
 *    the client via ADR-0011). The materializer projects it to `items.deleted_at`.
 * 2. This worker hard-deletes bottom-up (leaves first) only for tombstones
 *    that are BOTH older than the wall-clock retention floor AND acknowledged
 *    by every known replica (ADR-0019): a tombstone is eligible iff no replica
 *    has `last_synced_at IS NULL OR last_synced_at <= deleted_at` in
 *    `replica_sync`. A replica that synced past the tombstone can no longer
 *    revive the item; one that hasn't (or never did) blocks it.
 * 3. For each hard-deleted tombstone the worker ALSO removes the item's Yjs
 *    key (ADR-0006 "removing both"): the deletion is authored on the live room
 *    when one is loaded (broadcast to connected clients) or as a store delta
 *    otherwise, so the next projection pass cannot re-upsert the tombstone
 *    ("hard-delete sticks").
 * 4. Attachment rows are soft-deleted BEFORE the item row is hard-deleted
 *    (the RESTRICT FK requires it); S3 objects are removed after their own
 *    retention window (deferred GC — avoids the offline-undo race).
 *
 * In addition to the durable ledger gate, a document is skipped entirely while
 * ANY live connection for it has not completed its initial sync — this closes
 * the connect→sync race in-process and covers multiple tabs sharing one
 * `replicaId` (ADR-0019).
 *
 * Stale-replica policy (ADR-0019): before each pass, ledger rows for replicas
 * not seen for `replicaStaleTtlMs` are pruned. This bounds ledger growth and
 * auto-heals a connection whose sync-ack was lost (`last_synced_at` stays NULL
 * forever and would otherwise block its document's GC indefinitely). Forgetting
 * is safe because a returning replica re-registers a blocking row on connect
 * and re-gates until it re-acks, and tombstone key deletions are durable.
 *
 * All work runs under the per-document advisory lock shared with the projector
 * and compaction so they cannot interleave for the same document.
 */

export interface GcWorker {
  /** Run one GC pass across all documents. Returns count of hard-deleted items. */
  run(): Promise<number>;
  /** Return the current attachment S3 GC backlog count (for metrics). */
  backlogCount(): Promise<number>;
  /**
   * Count of documents with at least one tombstone currently blocked by the
   * replica-acknowledgement gate (ADR-0019) — the "stuck GC" signal for OPS.
   */
  blockedDocs(): Promise<number>;
}

export interface GcConfig {
  /** Minimum age of deleted_at before a row may be hard-deleted (ms). Default: 7 days. */
  retentionMs?: number;
  /** How many items to hard-delete per document per pass to bound lock hold time. */
  batchSize?: number;
  /**
   * Author tombstone key removals into the CRDT plane (ADR-0006/0019). Without
   * it, GC prunes rows only and the next projection pass re-upserts the
   * tombstone. main.ts wires this to `collab.removeTombstoneKeys`.
   */
  removeTombstoneKeys?: (documentId: string, itemIds: readonly string[]) => Promise<void>;
  /**
   * Live connection registry (ADR-0019): any live socket that has not completed
   * its initial sync blocks GC for its document, in addition to the durable
   * `replica_sync` gate.
   */
  liveConnections?: () => RegisteredConnection[];
  /**
   * Stale-replica pruning TTL (ADR-0019): replica_sync rows not seen for this
   * long are forgotten before each pass (bounds ledger growth; auto-heals lost
   * sync-acks). Default: 14 days.
   */
  replicaStaleTtlMs?: number;
  log?: (msg: string) => void;
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
  config: GcConfig,
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
          -- Replica-acknowledgement gate (ADR-0019): every known replica must
          -- have synced strictly past this tombstone. NULL = never synced =
          -- always blocks. Documents with no known replicas pass (nothing can
          -- resurrect).
          AND NOT EXISTS (
            SELECT 1 FROM replica_sync r
             WHERE r.document_id = $1
               AND (r.last_synced_at IS NULL OR r.last_synced_at <= i.deleted_at)
          )
        ORDER BY i.deleted_at
        LIMIT $3`,
      [documentId, cutoff, batchSize],
    );
    if (res.rows.length === 0) return 0;

    const itemIds = res.rows.map((r) => r.id);

    // Remove the item keys from the CRDT plane FIRST (same gate): once the key
    // is gone, no later projection pass can re-upsert the row, so the hard-
    // delete sticks. Best-effort — a failure logs and falls back to row-only
    // deletion (the next pass retries the churn case).
    if (config.removeTombstoneKeys) {
      try {
        await config.removeTombstoneKeys(documentId, itemIds);
      } catch (err) {
        config.log?.(
          `tombstone key removal failed for ${documentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    let deleted = 0;
    for (const id of itemIds) {
      await softDeleteAttachmentsForItem(tx, documentId, id);
      await tx.query(`DELETE FROM items WHERE id = $1 AND document_id = $2`, [
        id,
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
  const staleTtlMs = config.replicaStaleTtlMs ?? 14 * 24 * 60 * 60 * 1000; // 14 days
  const log = config.log ?? (() => {});

  async function gcBlockedDocs(): Promise<number> {
    const res = await db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT i.document_id) AS n
        FROM items i
        WHERE i.deleted_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM replica_sync r
             WHERE r.document_id = i.document_id
               AND (r.last_synced_at IS NULL OR r.last_synced_at <= i.deleted_at)
          )`,
    );
    return Number.parseInt(res.rows[0]?.n ?? '0', 10);
  }

  return {
    async run() {
      // Stale-replica policy first (ADR-0019): forget replicas not seen for the
      // TTL so a permanently-gone replica or a lost sync-ack cannot block GC
      // forever and ledger rows cannot grow unbounded. Safe because a returning
      // replica re-registers a blocking row on connect and re-gates until sync.
      const pruned = await pruneStaleReplicas(db, new Date(Date.now() - staleTtlMs));
      if (pruned > 0) log(`pruned ${pruned} stale replica_sync row(s)`);

      const cutoff = new Date(Date.now() - retentionMs);
      const docs = await getStaleDocuments(db, cutoff);

      // In-process supplement to the durable gate (ADR-0019): a document with
      // ANY live connection that hasn't completed its initial sync is skipped
      // entirely. Closes the connect→sync race (the ledger row for a brand-new
      // socket is written in `connected`, but a pass could otherwise read the
      // gate before that write lands) and covers any client still receiving its
      // first state regardless of its replica id — defense in depth on top of
      // the per-tab ledger (one synced tab must never unblock a sibling).
      const blockedByLiveConnection = new Set<string>();
      for (const entry of config.liveConnections?.() ?? []) {
        if (!entry.synced) blockedByLiveConnection.add(entry.documentName);
      }

      let total = 0;
      for (const documentId of docs) {
        if (blockedByLiveConnection.has(documentId)) continue;
        try {
          total += await gcDocument(db, documentId, cutoff, batchSize, config);
        } catch (err) {
          log(`GC failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
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

    blockedDocs: gcBlockedDocs,
  };
}
