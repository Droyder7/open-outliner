-- migrations/0002_integrity_v1.sql
-- Open-Outliner — V1 integrity hardening.
--
-- Forward-only follow-up to 0001_init_v1.sql. Addresses structural-integrity and
-- projection-durability gaps identified in the design review:
--
--   * Cross-document parenting was possible: items.parent_id only referenced
--     items(id), so a child in document A could point at a parent in document B.
--     Fixed with a composite (id, document_id) FK — a child and its parent MUST
--     share a document. (Critical #6a)
--   * Attachment identity could disagree with its item: an attachment's document_id
--     and its item's document_id were unconstrained. The attachments table (specified
--     in docs/attachments.md but never created in 0001) is created here with a
--     composite FK that pins an attachment's item to the same document. (Critical #6b,
--     High "attachment identity")
--   * The projection could regress or stall: no durable per-document revision existed
--     to make projection monotonic or to drive crash catch-up. Adds document_projection.
--     (Critical #5 / ADR-0013)
--
-- Design invariants (unchanged from 0001): CRDT decides, Postgres records and
-- validates (ADR-0004); no cascade on the item tree (ADR-0006); fractional ordering
-- (ADR-0005). See docs/adr/0010–0013 for the decisions this migration supports.

BEGIN;

-- ---------------------------------------------------------------------------
-- Same-document parenting (Critical #6a)
-- ---------------------------------------------------------------------------
-- A composite FK cannot target a bare PK; it needs a matching unique key. items.id
-- is already unique (PK), so (id, document_id) is trivially unique — this UNIQUE
-- exists only to serve as the composite FK target below.
ALTER TABLE items
  ADD CONSTRAINT items_id_document_uk UNIQUE (id, document_id);

-- Re-point parent_id at (id, document_id) so a child and its parent MUST belong to
-- the same document. Keeps ON DELETE RESTRICT (ADR-0006 — no cascade on the tree).
-- The old single-column FK is dropped and replaced. (The constraint name from 0001
-- is the Postgres default: <table>_<column>_fkey.)
ALTER TABLE items
  DROP CONSTRAINT items_parent_id_fkey;

ALTER TABLE items
  ADD CONSTRAINT items_parent_same_document_fk
  FOREIGN KEY (parent_id, document_id)
  REFERENCES items (id, document_id)
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Attachments (blob-plane metadata) — created here with same-document integrity
-- ---------------------------------------------------------------------------
-- docs/attachments.md specifies this table; 0001 never created it. Created now so
-- an attachment's item_id and document_id cannot disagree: the composite FK forces
-- the referenced item to live in the attachment's document. item_id is nullable
-- (an attachment may briefly exist before its item is created), but when present it
-- MUST match the document. (Critical #6b)
--
-- On delete: ON DELETE RESTRICT, NOT SET NULL. A composite SET NULL would try to null
-- document_id too (NOT NULL) and fail; more importantly, RESTRICT matches ADR-0006 —
-- items are hard-deleted only by the tombstone-aware GC, bottom-up and deliberate. GC
-- MUST detach or soft-delete an item's attachments (and GC their S3 objects after the
-- retention window) BEFORE it can physically delete the item row. The DB takes no
-- autonomous action on the blob plane.
CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_id       UUID,                 -- nullable; when set, must be in document_id (FK below)
  s3_key        TEXT,                 -- null until upload completes
  mime          TEXT NOT NULL,
  size          BIGINT NOT NULL,
  checksum      TEXT NOT NULL,        -- server-computed content hash: dedup + integrity
  uploaded_at   TIMESTAMPTZ,          -- null while pending
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,          -- soft-delete tombstone; GC removes S3 object after retention
  CONSTRAINT attachments_item_same_document_fk
    FOREIGN KEY (item_id, document_id)
    REFERENCES items (id, document_id)
    ON DELETE RESTRICT
);

CREATE INDEX attachments_document_idx ON attachments (document_id) WHERE deleted_at IS NULL;
CREATE INDEX attachments_item_idx     ON attachments (item_id)     WHERE deleted_at IS NULL;
-- Dedup identical blobs within a document by content hash.
CREATE INDEX attachments_checksum_idx ON attachments (document_id, checksum);

-- ---------------------------------------------------------------------------
-- Projection revision guard & catch-up (Critical #5 / ADR-0013)
-- ---------------------------------------------------------------------------
-- Per-document monotonic revisions. The materializer applies a projection pass only
-- when source_rev has advanced past projected_rev, and advances projected_rev in the
-- SAME transaction as its row upserts. A startup + interval sweep re-projects any
-- document where projected_rev < source_rev (recovers a projection lost to a crash
-- between yjs_updates persistence and the debounced onChange). source_rev - projected_rev
-- is the projection-lag metric for OPS monitoring.
CREATE TABLE document_projection (
  document_id    UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  -- How current the durable CRDT truth is (e.g. max applied yjs_updates.id).
  source_rev     BIGINT NOT NULL DEFAULT 0,
  -- The source_rev the items rows were last projected from. Behind iff < source_rev.
  projected_rev  BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_projection_not_ahead CHECK (projected_rev <= source_rev)
);

-- The catch-up sweep scans for stale documents; make that scan cheap.
CREATE INDEX document_projection_behind_idx
  ON document_projection (document_id)
  WHERE projected_rev < source_rev;

COMMIT;
