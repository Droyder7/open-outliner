-- migrations/0001_init_v1.sql
-- Open-Outliner — canonical V1 schema (schema of record).
--
-- This is the authoritative DDL. docs/data-model.md is decided commentary on it;
-- idea-research-report.md is exploratory history, not authority.
--
-- Scope: V1 only. Deferred V2 objects (item_closure, ltree/path, item_refs,
-- views, full-text search_tsv GIN) are intentionally NOT here — see
-- migrations/README.md for the deferral list and rationale.
--
-- Design invariants enforced or supported by this schema:
--   * "CRDT decides, Postgres records and validates" (ADR-0004): these tables are
--     the queryable projection of the Yjs document; constraints are integrity guards
--     on an already-resolved write, never conflict resolvers.
--   * No cascade on the item tree (ADR-0006): parent_id is ON DELETE RESTRICT;
--     user deletes are soft (deleted_at); physical removal is a tombstone-aware GC job.
--   * Fractional-index ordering (ADR-0005): rank is TEXT COLLATE "C" (byte-wise),
--     not unique; total order is (rank, id).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive tags

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'Untitled',
  root_item_id  UUID,  -- FK to items(id) added after items exists (see ALTER below)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_workspace_idx ON documents (workspace_id);

-- ---------------------------------------------------------------------------
-- Items (adjacency list + fractional order) — the core projection table
-- ---------------------------------------------------------------------------
-- The enum carries all six historical values because removing enum values later
-- is painful. V1 clients only ever WRITE the four structural types
-- (bullet|task|heading|divider); board|table are V2 view types (see yjs-schema.md).
CREATE TYPE item_type AS ENUM (
  'bullet', 'task', 'heading', 'divider', 'board', 'table'
);

CREATE TABLE items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- parent FK is intentionally ON DELETE RESTRICT, not CASCADE (ADR-0006).
  -- A physical CASCADE would erase a subtree without writing tombstones and
  -- break offline convergence. Hard-delete happens only in the GC job.
  parent_id       UUID REFERENCES items(id) ON DELETE RESTRICT,
  -- Sibling order: fractional index. COLLATE "C" => byte-wise lexicographic
  -- ordering (non-negotiable, ADR-0005). Not unique; total order is (rank, id).
  rank            TEXT COLLATE "C" NOT NULL,
  type            item_type NOT NULL DEFAULT 'bullet',
  content         TEXT NOT NULL DEFAULT '',   -- plain-text projection of the Y.Text (search/API)
  content_json    JSONB,                      -- rich text / TipTap snapshot refs
  note            TEXT,                       -- Dynalist-style note body
  is_completed    BOOLEAN NOT NULL DEFAULT false,
  is_collapsed    BOOLEAN NOT NULL DEFAULT false,
  color           TEXT,                       -- API-plane (non-structural) in V1
  metadata        JSONB NOT NULL DEFAULT '{}',
  -- Parsed date attributes (API/relational plane in V1; not CRDT-merged).
  due_at          TIMESTAMPTZ,
  start_at        TIMESTAMPTZ,
  recur_rule      TEXT,                       -- RRULE or app-specific
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,                -- soft-delete tombstone (sync/undo)
  version         BIGINT NOT NULL DEFAULT 1   -- optimistic concurrency for the API path
);

-- Exactly one live root (parent_id IS NULL) per document. A partial unique index
-- expresses "is a root" that a CHECK cannot (a PK is never NULL).
CREATE UNIQUE INDEX items_one_root_per_doc_idx
  ON items (document_id)
  WHERE parent_id IS NULL AND deleted_at IS NULL;

-- Children of a node, in order — the hottest read path.
CREATE INDEX items_parent_rank_idx
  ON items (document_id, parent_id, rank)
  WHERE deleted_at IS NULL;

-- Direct lookup + sync scan.
CREATE INDEX items_document_id_idx
  ON items (document_id)
  WHERE deleted_at IS NULL;

-- Incomplete tasks (task-list views).
CREATE INDEX items_open_tasks_idx
  ON items (document_id, is_completed)
  WHERE type = 'task' AND deleted_at IS NULL AND is_completed = false;

-- Now that items exists, wire documents.root_item_id.
ALTER TABLE documents
  ADD CONSTRAINT documents_root_item_fk
  FOREIGN KEY (root_item_id) REFERENCES items(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Tags (derived attribute; keeps the item row lean)
-- ---------------------------------------------------------------------------

CREATE TABLE item_tags (
  item_id  UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag      CITEXT NOT NULL,   -- #project, @person
  PRIMARY KEY (item_id, tag)
);

CREATE INDEX item_tags_tag_idx ON item_tags (tag);

-- ---------------------------------------------------------------------------
-- Membership / permissions
-- ---------------------------------------------------------------------------

CREATE TABLE document_members (
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
  PRIMARY KEY (document_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Sync log (queryable change feed; clients pull WHERE id > $last_change_id)
-- ---------------------------------------------------------------------------

CREATE TABLE item_changes (
  id           BIGSERIAL PRIMARY KEY,
  document_id  UUID NOT NULL,
  item_id      UUID NOT NULL,
  op           TEXT NOT NULL,   -- insert|update|move|delete
  payload      JSONB NOT NULL,
  actor_id     UUID,
  client_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX item_changes_doc_id_idx ON item_changes (document_id, id);

-- ---------------------------------------------------------------------------
-- Durable CRDT state (owned by Hocuspocus; the collab source of truth)
-- ---------------------------------------------------------------------------

CREATE TABLE yjs_updates (
  document_id  UUID NOT NULL,
  update       BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX yjs_updates_doc_idx ON yjs_updates (document_id, created_at);

COMMIT;
