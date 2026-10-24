import { withDocumentLock } from '../db/db.js';
import type { Db, TxClient } from '../db/db.js';
import type { PreparedTombstoneKeyRemoval } from '../crdt/gc-keys.js';
import { softDeleteAttachmentsForItem } from '../db/attachments-repo.js';
import { getPendingS3Deletions, clearS3Key, gcBacklogCount } from '../db/attachments-repo.js';
import { pruneStaleReplicas, pruneNeverAckedOverflow } from '../db/replica-sync-repo.js';
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
 *    retained before acquiring the lock (broadcast to connected clients), so
 *    the next projection pass cannot re-upsert the tombstone ("hard-delete sticks").
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
 * Preparation/replay and release run OUTSIDE the per-document advisory lock.
 * Eligibility checks and deletion run inside it (ADR-0020).
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
   * Load and retain the CRDT document BEFORE taking its lock (ADR-0020).
   * The handle must remove/persist without replay and release after the GC
   * transaction ends. Production wires this to the collaboration server;
   * SQL-only tests may omit it when no CRDT state exists.
   */
  prepareTombstoneKeyRemoval?: (documentId: string) => Promise<PreparedTombstoneKeyRemoval>;
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
  /**
   * Cap on never-acked (`last_synced_at IS NULL`) ledger rows per document
   * (ADR-0019 accepted-downside guard against a client cycling fresh replica
   * ids without ever syncing). Default: 64.
   */
  neverAckedCap?: number;
  log?: (msg: string) => void;
}

async function getStaleDocuments(db: Db, cutoff: Date): Promise<string[]> {
  // Oldest-tombstone-first so the bounded pass makes deterministic progress:
  // with a bare LIMIT and no ordering, which documents each pass sees is
  // unspecified and a document could be repeatedly unlucky.
  const res = await db.query<{ document_id: string }>(
    `SELECT document_id FROM items
      WHERE deleted_at IS NOT NULL AND deleted_at < $1
      GROUP BY document_id
      ORDER BY MIN(deleted_at)
      LIMIT 200`,
    [cutoff],
  );
  return res.rows.map((r) => r.document_id);
}

/** Same candidate query before preparation and under the lock; the latter is authoritative. */
async function eligibleItemIds(
  queryable: Pick<Db, 'query'> | TxClient,
  documentId: string,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const res = await queryable.query<{ id: string }>(
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
    [documentId, cutoff, limit],
  );
  return res.rows.map((row) => row.id);
}

function hasUnsyncedConnection(config: GcConfig, documentId: string): boolean {
  return (config.liveConnections?.() ?? []).some(
    (entry) => entry.documentName === documentId && !entry.synced,
  );
}

async function gcDocument(
  db: Db,
  documentId: string,
  cutoff: Date,
  batchSize: number,
  config: GcConfig,
): Promise<number> {
  // Avoid loading rooms that cannot make progress. Never trust this preflight
  // for deletion: projection/replica state may change while preparation awaits.
  if (hasUnsyncedConnection(config, documentId)) return 0;
  if ((await eligibleItemIds(db, documentId, cutoff, 1)).length === 0) return 0;
  const prepared = await config.prepareTombstoneKeyRemoval?.(documentId);
  try {
    return await withDocumentLock(db, documentId, async (tx) => {
      if (hasUnsyncedConnection(config, documentId)) return 0;
      const itemIds = await eligibleItemIds(tx, documentId, cutoff, batchSize);
      // A client may have joined while the eligibility query was pending.
      if (itemIds.length === 0 || hasUnsyncedConnection(config, documentId)) return 0;

      // Fail closed: persistence must succeed before any relational deletion.
      // The prepared handle holds a live doc and MUST NOT replay stored history.
      await prepared?.remove(itemIds);
      for (const id of itemIds) {
        await softDeleteAttachmentsForItem(tx, documentId, id);
        await tx.query(`DELETE FROM items WHERE id = $1 AND document_id = $2`, [id, documentId]);
      }
      return itemIds.length;
    });
  } finally {
    // Disconnect can persist/unload the room: keep this outside the transaction
    // and don't let cleanup errors mask a deletion failure or committed result.
    try {
      await prepared?.release();
    } catch (err) {
      config.log?.(
        `GC release failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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

export function createGcWorker(db: Db, config: GcConfig = {}, s3?: S3Service): GcWorker {
  const retentionMs = config.retentionMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const batchSize = config.batchSize ?? 500;
  const staleTtlMs = config.replicaStaleTtlMs ?? 14 * 24 * 60 * 60 * 1000; // 14 days
  const neverAckedCap = config.neverAckedCap ?? 64;
  const log = config.log ?? (() => {});

  async function gcBlockedDocs(): Promise<number> {
    // Apply the same retention cutoff as the actual gate: without it, any
    // document with a tombstone newer than some offline replica's last ack
    // counts as "blocked" — the normal steady state, not a stuck ledger. This
    // metric is the "stuck GC" signal (ADR-0019 OPS visibility), so it must
    // count only tombstones that are eligible-but-gated.
    const cutoff = new Date(Date.now() - retentionMs);
    const res = await db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT i.document_id) AS n
        FROM items i
        WHERE i.deleted_at IS NOT NULL
          AND i.deleted_at < $1
          AND EXISTS (
            SELECT 1 FROM replica_sync r
             WHERE r.document_id = i.document_id
               AND (r.last_synced_at IS NULL OR r.last_synced_at <= i.deleted_at)
          )`,
      [cutoff],
    );
    return Number.parseInt(res.rows[0]?.n ?? '0', 10);
  }

  let running = false;

  async function runPass(): Promise<number> {
    // Stale-replica policy first (ADR-0019): forget replicas not seen for the
    // TTL so a permanently-gone replica or a lost sync-ack cannot block GC
    // forever and ledger rows cannot grow unbounded. Safe because a returning
    // replica re-registers a blocking row on connect and re-gates until sync.
    const pruned = await pruneStaleReplicas(db, new Date(Date.now() - staleTtlMs));
    if (pruned > 0) log(`pruned ${pruned} stale replica_sync row(s)`);
    // Bound never-acked rows per document (ADR-0019 accepted-downside guard):
    // a client that never syncs legitimately gates its document, but a client
    // cycling fresh replica ids must not bloat the ledger for a whole TTL.
    const prunedNeverAcked = await pruneNeverAckedOverflow(db, neverAckedCap);
    if (prunedNeverAcked > 0) {
      log(`pruned ${prunedNeverAcked} never-acked replica_sync row(s) over the cap`);
    }

    const cutoff = new Date(Date.now() - retentionMs);
    const docs = await getStaleDocuments(db, cutoff);

    let total = 0;
    for (const documentId of docs) {
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
  }

  return {
    async run() {
      if (running) return 0;
      running = true;
      try {
        return await runPass();
      } finally {
        running = false;
      }
    },

    async backlogCount() {
      return gcBacklogCount(db);
    },

    blockedDocs: gcBlockedDocs,
  };
}
