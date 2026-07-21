-- migrations/0003_sessions_and_membership_v1.sql
-- Open-Outliner — session auth + workspace membership (ADR-0014).
--
-- Forward-only follow-up to 0001/0002. Reconciles the schema with the identity
-- model pinned in ADR-0014 (owner + equal workspace members; server-side killable
-- sessions), which 0001 predated:
--
--   * 0001 gave `document_members.role` a four-value CHECK
--     (owner/editor/commenter/viewer). ADR-0014 decides V1 has NO per-document
--     roles — sharing is workspace-level with one owner and equal members. The
--     stale CHECK is replaced with the two-value owner|member model, and the
--     authoritative membership moves to a workspace-scoped table.
--   * 0001 left `workspaces.owner_id` and `*_members.user_id` as bare UUIDs with
--     no user table to reference. A `users` table is added and those columns are
--     wired to it.
--   * ADR-0014 requires a killable server-side session store (an opaque cookie
--     resolves to a session row on every REST request and WS re-auth; revocation
--     is a single DELETE/UPDATE effective on the next check). Added here.
--
-- Design invariants (unchanged): the workspace is the tenant boundary; membership
-- is authoritative relational data, never in Yjs (ADR-0004/0014).

BEGIN;

-- ---------------------------------------------------------------------------
-- Users (authoritative identity)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT NOT NULL UNIQUE,        -- case-insensitive login identity
  display_name  TEXT,
  -- Opaque password verifier (e.g. argon2/bcrypt hash). Nullable to allow
  -- invited-but-not-yet-activated users; login requires it to be set.
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wire the previously-unreferenced owner column to users. RESTRICT: a workspace
-- must not be orphaned by deleting its owner out from under it.
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_owner_fk
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Workspace membership (owner + equal members) — authoritative, ADR-0014
-- ---------------------------------------------------------------------------
-- The workspace is the tenant boundary; every member has equal read-write access
-- to EVERY document in the workspace. There are no per-document roles in V1.
-- `role` distinguishes only the single owner from equal members.
CREATE TABLE workspace_members (
  workspace_id  UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Reverse lookup: "which workspaces is this user a member of?" (auth resolution).
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- Exactly one owner per workspace.
CREATE UNIQUE INDEX workspace_members_one_owner_idx
  ON workspace_members (workspace_id)
  WHERE role = 'owner';

-- ---------------------------------------------------------------------------
-- Reconcile the stale document_members.role CHECK (ADR-0014)
-- ---------------------------------------------------------------------------
-- ADR-0014 removes per-document roles from V1. `document_members` is retained as
-- a compatibility surface, but its role vocabulary is narrowed to the same
-- owner|member model as workspace membership — the four-value viewer/commenter/
-- editor CHECK from 0001 is replaced. The CHECK constraint name from 0001 is the
-- Postgres default: <table>_<column>_check.
ALTER TABLE document_members
  DROP CONSTRAINT document_members_role_check;

ALTER TABLE document_members
  ADD CONSTRAINT document_members_role_check CHECK (role IN ('owner', 'member'));

-- Wire document_members.user_id to users now that the table exists.
ALTER TABLE document_members
  ADD CONSTRAINT document_members_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Killable server-side session store (ADR-0014)
-- ---------------------------------------------------------------------------
-- The opaque, httpOnly cookie carries only the session id; the server resolves it
-- to this row on every REST request and every Hocuspocus re-auth. Revocation sets
-- `revoked_at` (or the row is deleted), effective on the very next check with no
-- token-expiry lag — the enforcement point for ADR-0014 revocation and the
-- offline-access-loss rejection.
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,           -- absolute expiry (idle/max lifetime)
  revoked_at  TIMESTAMPTZ,                     -- set on logout / membership removal
  -- Best-effort audit for the awareness/rate-limit hardening (ADR-0014 open items).
  user_agent  TEXT,
  ip          INET,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Resolve this user's live sessions" and "kill all sessions for a user" (the
-- revocation path) both scan by user; make it cheap and skip dead rows.
CREATE INDEX sessions_user_live_idx
  ON sessions (user_id)
  WHERE revoked_at IS NULL;

COMMIT;
