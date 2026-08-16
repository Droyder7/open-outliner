import type { Db } from './db.js';

/**
 * Replica sync-acknowledgement ledger (ADR-0019): records how far each replica
 * of a document has acknowledged the server's state, so tombstone-aware GC can
 * bound its retention window on replica acknowledgement instead of a bare wall
 * clock (ADR-0006).
 *
 * `last_synced_at` is the ONLY signal that unblocks GC: it is set when a replica
 * completes a sync with the server (the client's `replica.synced` stateless ack,
 * or a heartbeat-tick/disconnect refresh for a connection that had already
 * completed its initial sync). `last_seen_at` is pure liveness — it never
 * unblocks GC, it only bounds how stale a replica's record is.
 */

export interface ReplicaTouch {
  documentId: string;
  replicaId: string;
  /** True when this touch is proof the replica completed a sync with the server. */
  synced: boolean;
}

/**
 * Upsert one replica's acknowledgement. `last_synced_at` advances only when
 * `synced` is true, and is monotonic (GREATEST) so a reconnect can never regress
 * a replica past a tombstone. `last_seen_at` advances on every touch.
 */
export async function touchReplica(
  db: Db,
  touch: ReplicaTouch,
  at: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO replica_sync (document_id, replica_id, last_synced_at, last_seen_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (document_id, replica_id) DO UPDATE SET
       last_synced_at = GREATEST(replica_sync.last_synced_at, EXCLUDED.last_synced_at),
       last_seen_at   = GREATEST(replica_sync.last_seen_at, EXCLUDED.last_seen_at)`,
    [touch.documentId, touch.replicaId, touch.synced ? at : null, at],
  );
}

/**
 * Prune ledger rows for replicas that have not been seen (connected, acked, or
 * heartbeat-ticked) since `olderThan` — ADR-0019 stale-replica policy.
 *
 * `last_seen_at` advances on every touch, so a row that survives past the TTL is
 * a replica that is either connected-but-mid-sync (the heartbeat keeps advancing
 * it) or a replica that has genuinely not been heard from for the whole window:
 * a permanently-gone replica, or a connection whose stateless ack was lost. Both
 * would otherwise block its document's GC forever.
 *
 * This is safe because forgetting is NOT the end of the ack bound: a replica
 * that returns later re-registers a blocking row in the `connected` hook
 * (`last_synced_at = NULL`) and re-gates its document until it completes a sync
 * and re-acks — and the tombstone key deletions GC authored while it was away
 * are durable updates, so the returning replica converges through normal sync
 * (see ADR-0019, stale-replica TTL). Returns the number of rows pruned.
 */
export async function pruneStaleReplicas(db: Db, olderThan: Date): Promise<number> {
  const res = await db.query(
    `DELETE FROM replica_sync WHERE last_seen_at < $1`,
    [olderThan],
  );
  return res.rowCount ?? 0;
}

/**
 * True when any known replica of the document has NOT acknowledged sync past
 * `since` (or has never completed a sync at all) — i.e. GC must NOT hard-delete
 * a tombstone projected at `since`. False when the document has no known
 * replicas (nothing can resurrect: no replica is known to hold pre-tombstone
 * state).
 */
export async function hasUnsyncedReplicaPast(
  db: Db,
  documentId: string,
  since: Date,
): Promise<boolean> {
  const res = await db.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM replica_sync
        WHERE document_id = $1
          AND (last_synced_at IS NULL OR last_synced_at <= $2)
     ) AS blocked`,
    [documentId, since],
  );
  return res.rows[0]?.blocked ?? false;
}
