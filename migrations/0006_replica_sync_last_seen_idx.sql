-- Support the stale-replica prune performed on each GC pass (issue #3).
BEGIN;

CREATE INDEX replica_sync_last_seen_at_idx ON replica_sync (last_seen_at);

COMMIT;
