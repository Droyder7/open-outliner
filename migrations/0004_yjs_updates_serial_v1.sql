-- migrations/0004_yjs_updates_serial_v1.sql
-- Open-Outliner — add the monotonic id ADR-0013 relies on for source_rev.
--
-- ADR-0013 defines source_rev as "the max yjs_updates.id applied (a BIGSERIAL)",
-- and the persistence store (ADR-0015) advances source_rev on every durable
-- update. But 0001 created yjs_updates with no such column — it had only
-- (document_id, update, created_at). Without a per-row monotonic id the
-- projection revision guard has nothing to compare, so the materializer cannot
-- tell a newer pass from an older one.
--
-- This adds the BIGSERIAL id (forward-only; 0001/0003 already shipped and are
-- immutable). Existing rows get ids in insertion order via the sequence.

BEGIN;

ALTER TABLE yjs_updates
  ADD COLUMN id BIGSERIAL;

-- The id is the ordering/identity key the projection guard reads. A PK also gives
-- us a stable "max id per document" for source_rev and a target for compaction
-- truncation (Phase 12).
ALTER TABLE yjs_updates
  ADD CONSTRAINT yjs_updates_pkey PRIMARY KEY (id);

-- "max id for this document" — the source_rev computation on every store.
CREATE INDEX yjs_updates_doc_id_desc_idx ON yjs_updates (document_id, id DESC);

COMMIT;
