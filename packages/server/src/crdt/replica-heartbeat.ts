import type { Db } from '../db/db.js';
import { touchReplicasBatch, type ReplicaTouch } from '../db/replica-sync-repo.js';
import type { ConnectionRegistry } from './connections.js';

/**
 * Replica-acknowledgement heartbeat (ADR-0019): periodically refresh the
 * `replica_sync` ledger for live connections.
 *
 * Why a tick at all: a client that stays connected and idle never re-sends its
 * sync-ack (the provider only re-syncs on (re)connect), so its acknowledgement
 * would otherwise go stale and block GC forever even though it received every
 * broadcast, including a tombstone. A connection that has completed its
 * initial sync (`entry.synced`) has received everything the server had up to
 * that point and keeps receiving broadcasts — refreshing its acknowledgement
 * on a live tick is the "continuously live = synced past" bound.
 *
 * A connection that has NOT yet completed its initial sync is never treated as
 * synced here (only its `last_seen_at` advances), which closes the
 * connect→sync-complete race: GC cannot hard-delete while a replica is still
 * receiving its first state.
 */
export function startReplicaHeartbeat(
  db: Db,
  registry: ConnectionRegistry,
  intervalMs: number,
  log: (msg: string) => void = () => {},
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const at = new Date();
        const touches: ReplicaTouch[] = [];
        for (const entry of registry.liveConnections()) {
          if (!entry.replicaId) continue; // legacy client — nothing to track
          touches.push({
            documentId: entry.documentName,
            replicaId: entry.replicaId,
            synced: entry.synced,
          });
        }
        await touchReplicasBatch(db, touches, at);
      } catch (err) {
        log(`replica heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
