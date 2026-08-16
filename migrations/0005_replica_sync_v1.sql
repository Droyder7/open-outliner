-- migrations/0005_replica_sync_v1.sql
-- Open-Outliner — replica sync-acknowledgement ledger for tombstone-aware GC (ADR-0019).
--
-- ADR-0006 requires the GC retention window to be a replica-acknowledgement bound,
-- not a bare wall clock: a tombstone may be hard-deleted only once every known
-- replica has synced PAST it, so an offline replica can never re-establish a
-- physically-gone item. ADR-0019 decides the mechanism: clients identify
-- themselves with their stable HLC replica id (ADR-0009, `oo:replicaId`) on the
-- Hocuspocus connection, and this table records how far each replica has
-- acknowledged.
--
--   last_synced_at  — set ONLY when the replica completes a sync with the server
--                     (client `replica.synced` stateless ack, or a heartbeat tick /
--                     disconnect for a connection that already completed its
--                     initial sync). NULL = the replica has never completed a
--                     sync, so it must block GC.
--   last_seen_at    — liveness: connect, heartbeat tick, disconnect. Never
--                     unblocks GC by itself; it only bounds staleness.
--
-- A row's `last_synced_at` is monotonic (GREATEST upsert, see
-- replica-sync-repo.ts); the GC gate (jobs/gc.ts) blocks hard-delete while ANY
-- known replica has `last_synced_at <= tombstone.deleted_at`.

BEGIN;

CREATE TABLE replica_sync (
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  replica_id     TEXT NOT NULL,
  -- NULL until the replica's first completed sync (ADR-0019). NULL blocks GC:
  -- the replica is known but has never acknowledged the server's state.
  last_synced_at TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, replica_id)
);

-- The GC gate reads "min over replicas" per document; the PK covers it.
-- (No extra index: the gate query filters by document_id, which the PK leads with.)

COMMIT;
