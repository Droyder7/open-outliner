# Open-Outliner: Dynalist & Workflowy Successor Architecture Report

A comprehensive research report and technical specification for building an open-source successor to Dynalist and Workflowy. Covers system design, tech stack selection, recursive PostgreSQL schema, concurrent tree move resolution, fractional indexing, and offline-first real-time synchronization.

---


# Architectural Approaches for an Open-Source Successor

Several viable paths exist for an open-source Dynalist + Workflowy successor. Below are five approaches ranked by fit for a **web-first SPA/PWA**, a simple hierarchical item model, and a backend-heavy developer profile (Node.js, PostgreSQL, cloud). Each maps to lessons from the earlier research: multi-doc + global views, mirrors, boards/tables, patch-style APIs, and offline/sync.

---

# Choosing the right tech stack for real-time offline-first applications

For a real-time, offline-first Dynalist/Workflowy successor, a highly suitable stack today is: **React/Vite-based PWA + IndexedDB (or SQLite in the browser) for local-first storage + a CRDT engine like Yjs over WebSockets + a Node.js/TypeScript backend with PostgreSQL**. This gives you real-time collaboration, robust offline behavior, and an OSS-friendly, cloud-native architecture.

Below are the main choices and trade-offs, tuned to your use case.

***

## Core Architectural Principles

- **Offline-first by design, not as a bolt-on**: writes must succeed locally even when the network is down, with background sync later.
- **Real-time collaboration via CRDTs**: conflict-free replicated data types handle concurrent edits across devices without a central “source of truth”, which is ideal for shared outlines.
- **PWA as your primary client**: modern PWAs (service workers, background sync, push, installability) are now good enough for serious productivity apps on web and mobile.

These principles should guide every stack decision.

***

## Frontend Stack: Web-First PWA

### Recommended baseline

- **Framework**: React + TypeScript with Vite (or Next.js if you want SSR/ISR for marketing and auth pages).
- **State & view layer**:
    - Local UI state: React Query / TanStack Query + a lightweight global store (Zustand or Redux Toolkit).
    - Collaborative text/outline state: Yjs document bound to your editor/outliner components.
- **Offline storage**: IndexedDB via Dexie or idb-keyval; pattern: local queue for mutations + cached reads.
- **PWA plumbing**:
    - Service worker using Workbox or vite-plugin-pwa for precache + runtime caching.
    - Background Sync for retrying failed writes when the network returns.

This pattern (React + Dexie + service worker + Yjs) is the same one used in reference offline-first and collaborative note apps in the last two years.

### Why not heavier frontends?

- Vue/Svelte/Solid are fine, but React has the richest ecosystem around **TipTap + Yjs**, collab examples, and PWA tooling, which reduces integration friction.
- For your use case (block-based outliner, boards, tables), React + TipTap or a custom node-based outliner is already battle-tested in real-time note apps.

***

## Collaboration & Sync Layer

This is the crucial decision for real-time + offline.

### Option A: Yjs + custom WebSocket server (recommended)

- **CRDT engine**: Yjs for text and tree structures.
- **Transport**:
    - Hocuspocus (Yjs-compatible WebSocket server) or a custom Node/WS service.
- **Pros**:
    - Proven in many Google Docs–style clones and collaborative note apps.
    - Handles concurrency, offline edits, and network partitions elegantly.
    - You keep full control of data flow and can map Yjs docs onto PostgreSQL rows/JSON.
- **Cons**:
    - Yjs adds conceptual overhead (CRDT awareness, persistence layer design).
    - You design your own presence, awareness, and permissions logic.

This aligns with case studies where teams switched from OT to CRDTs for simpler conflict resolution in distributed note systems.

### Option B: Local-first sync engines (Replicache / ElectricSQL / etc.)

- Engines like **Replicache, ElectricSQL, PowerSync, Jazz** provide a “replicated DB” abstraction where local writes sync to a backend and merge via CRDT-like logic.
- Pros: simplified API (mutations & queries) and great offline semantics, but many are not yet as widely used for complex tree/outline editors as Yjs.
- For a first version, Yjs is more standard in the “collaborative editor” niche; you can reassess once you want more DB-like semantics.

### Option C: Firebase/Firestore/Hosted realtime DB

- Technically simpler for prototypes, but not aligned with your **open-source, self-hosted, and data ownership** goals.
- You lose control over infra and may complicate local-first guarantees.

Given your background and OSS goals, **Option A (Yjs + Node WS)** is the most suitable.

***

## Backend Stack: API, Persistence, and Auth

### Recommended baseline

- **Language/runtime**: Node.js + TypeScript.
- **Framework**:
    - HTTP API: Express, Fastify, or NestJS (NestJS is attractive if you like structured modules and decorators).
    - WebSocket server: either integrated into the same Node app or separate (Hocuspocus server, custom WS).
- **Database**: PostgreSQL (core outlines, users, ACL, audit), with JSONB columns for Yjs snapshots or per-item metadata.
- **Storage**: S3-compatible object storage (DO Spaces/MinIO) for file and image attachments.
- **Auth**:
    - JWT-based auth for API & WebSocket.
    - Optional OAuth2 (GitHub/Google) for easier onboarding.
    - Support refresh tokens and device-level keys to make offline sessions smooth.

Real-world collaborative note apps commonly use a stack like **React + Node/Express + Mongo/Postgres + WebSockets**, with Yjs/TipTap on the collaboration side. You can substitute MongoDB for Postgres if you prefer document storage, but Postgres matches your experience and gives you strong relational guarantees for permissions, billing, and analytics.

### Backend responsibilities for offline-first

Guides on offline-first React/PWAs stress that the backend must support safe replay:

- **Idempotency keys** on mutation endpoints to handle queued retries (from background sync or local mutation queues).
- **Conflict handling** (e.g., 409 responses) with clear semantics for clients.
- Audit fields like `client_timestamp`, `server_timestamp`, and `synced_at` for debugging sync issues.

***

## Example End-to-End Stack Patterns

### Pattern 1: PWA + Yjs + Node/Postgres (strong OSS alignment)

- **Frontend**: React + Vite, Dexie for IndexedDB, TipTap/Yjs for editor.
- **Collab**: Yjs + Hocuspocus server over WebSockets.
- **Backend**: Node/Nest + PostgreSQL, S3 storage.
- **Offline-first**:
    - Service worker via Workbox/vite-plugin-pwa.
    - Local mutation queue (IndexedDB) + background sync.

This is closest to current “best practice” for Google-Docs-like note apps in system design guides.

### Pattern 2: Local-first DB engine + Outliner

- **Frontend**: React, local DB (ElectricSQL/Replicache) that syncs to Postgres.
- **Collab**: CRDT built into the sync engine, plus WebSockets.
- **Backend**: Node + Postgres, generator code provided by the engine.

You get less control over the CRDT layer, but more convenience for queries and offline semantics. This may be better if you later turn the outline model into generic “blocks” or more DB-like operations.

### Pattern 3: Next.js + Supabase + Yjs (fast iteration)

- **Frontend**: Next.js (app router) with React components, PWA configured.
- **Backend**: Supabase (Postgres + auth + storage + Realtime).
- **Collab**: Yjs via Hocuspocus or mapping onto Supabase Realtime channels.

Great for speed, but depends on Supabase for infra; still OSS-friendly and self-hostable, but adds another moving part. Good for v0/v1 if you want to avoid building auth/storage/WS from scratch.

***

## How to Choose for Your Project

Given your constraints and goals:

1. **You want OSS, self-hostable, and cloud-native** → avoid Firebase; prefer Node + Postgres or Supabase.
2. **You want rich real-time collaboration on outlines, boards, tables** → use a CRDT that’s battle-tested for editors: Yjs.
3. **You want web-first and offline-first semantics** → build a PWA with service workers, IndexedDB queue + background sync patterns that guides already validate.

So the practical recommendation is:

> **Go with Pattern 1: React/Vite PWA + IndexedDB + service worker (Workbox) + Yjs/Hocuspocus on WebSockets + Node/Nest/Postgres backend.**

You can later modularize the sync layer (swap Hocuspocus for another engine) or add local-first DB engines if you decide to generalize beyond outlines.

---

# Architecting a Database Schema for Recursive Item Relationships

For a Dynalist/Workflowy-style outliner, the hierarchy is not a side concern — it *is* the product. Every zoom, indent, mirror, board column, and offline sync path depends on how parent–child (and eventually many-to-many) relationships are stored and queried.

Below is a practical architecture for **PostgreSQL**, tuned for: deep nesting, frequent reorder/move, multi-document workspaces, mirrors, offline-first patch sync, and web-first SPA loads.

***

## What the Product Actually Needs

An outliner is not a simple org chart. Typical operations:

| Operation | Frequency | Query shape |
| :-- | :-- | :-- |
| Load children of a zoomed node | Very high | 1 level, ordered |
| Expand/collapse subtree | High | N levels, limited depth |
| Indent / outdent / drag reorder | Very high | Local parent + sibling order update |
| Move subtree under another parent | Medium | Relink root of subtree |
| Breadcrumbs (ancestors) | High | Path to root |
| Search within document / workspace | High | Filter + optional subtree scope |
| Backlinks / mirrors | Medium | Graph edges, not pure tree |
| Sync batch of patches | High | Point updates by `item_id` |

**Implication:** you need **fast sibling lists and cheap moves**, not only “get entire subtree in one shot.” Nested sets excel at subtree reads but punish moves; pure adjacency lists are move-friendly but need help for deep reads and path queries.

***

## Hierarchy Patterns Compared

### 1. Adjacency list (`parent_id`)

```sql
parent_id UUID NULL REFERENCES items(id)
```

- **Pros:** Simple inserts/deletes; indent/outdent is a single-row update; maps cleanly to CRDT/patch APIs and client trees.
- **Cons:** Full subtree / all-ancestors need recursive CTEs; deep trees + bad indexes can hurt.

**Best default for outliners** where structure changes constantly.

### 2. Closure table (ancestor–descendant)

Separate table of all `(ancestor_id, descendant_id, depth)` pairs.

- **Pros:** O(1)-style ancestor/descendant lookups via joins; great for permissions, “everything under this node,” relationship degree.
- **Cons:** Writes multiply rows on insert/move; maintenance cost on large moves.

**Strong add-on** when you need fast “all descendants” or ACL inheritance without deep recursion every time.

### 3. Materialized path / `ltree`

Store path like `root.child.grandchild` or Postgres `ltree`.

- **Pros:** Prefix search for subtrees; good for static-ish trees and path-ordered lists.
- **Cons:** Moving a node forces path rewrites for the whole subtree — painful for drag-heavy outliners.

**Useful as a cache**, not as the only source of truth for mutable outlines.

### 4. Nested sets (`left` / `right`)

- **Pros:** Excellent “all descendants” range queries.
- **Cons:** Inserts/moves renumber large ranges; poor fit for collaborative, high-churn outlines.

**Avoid as primary model** for Dynalist/Workflowy-class apps.

### Hybrid recommendation

| Layer | Role |
| :-- | :-- |
| **Adjacency list + sibling order** | Source of truth for structure |
| **Optional closure table or `ltree` cache** | Fast subtree/ancestor/breadcrumb reads |
| **Separate edge table for mirrors** | DAG / multi-parent without breaking the tree |

This matches common production advice: start with parent–child + recursive CTEs; add closure/`ltree` when read patterns demand it.

***

## Core Schema Design

### Workspaces and documents

Dynalist’s multi-doc model and Workflowy’s single infinite doc both map to:

- **Workspace** (tenant / account)
- **Document** (file, or one “main” doc per workspace)
- **Item** (bullet / node)

```sql
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
  root_item_id  UUID,  -- FK added after items exist
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_workspace_idx ON documents(workspace_id);
```

Each document has a **synthetic root item** so every real bullet has a parent (simplifies recursion and zoom).

***

### Items table (adjacency list + order)

```sql
CREATE TYPE item_type AS ENUM (
  'bullet', 'task', 'heading', 'divider', 'board', 'table'
);

CREATE TABLE items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- NOTE: parent FK is intentionally ON DELETE RESTRICT, not CASCADE.
  -- User-facing deletes are soft (deleted_at tombstone) so offline clients
  -- can converge; a physical CASCADE here would silently erase a subtree
  -- and skip tombstoning, breaking sync. Hard-delete happens only in a
  -- tombstone-aware GC job (see "Deletion & GC" note below).
  parent_id       UUID REFERENCES items(id) ON DELETE RESTRICT,
  -- Sibling order: fractional indexing (see below)
  rank            TEXT NOT NULL,
  type            item_type NOT NULL DEFAULT 'bullet',
  content         TEXT NOT NULL DEFAULT '',
  content_json    JSONB,              -- rich text / TipTap-Yjs snapshot refs
  is_completed    BOOLEAN NOT NULL DEFAULT false,
  is_collapsed    BOOLEAN NOT NULL DEFAULT false,
  color           TEXT,
  note            TEXT,               -- Dynalist-style notes under bullet
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,        -- soft delete for sync/undo
  version         BIGINT NOT NULL DEFAULT 1  -- optimistic concurrency
);

-- Exactly one live root (parent_id IS NULL) per document.
-- This replaces a naive CHECK — `id IS NOT NULL` is always true for a PK,
-- so a CHECK cannot express "is a root"; a partial unique index can.
CREATE UNIQUE INDEX items_one_root_per_doc_idx
  ON items (document_id)
  WHERE parent_id IS NULL AND deleted_at IS NULL;

-- Children of a node, in order
CREATE INDEX items_parent_rank_idx
  ON items (document_id, parent_id, rank)
  WHERE deleted_at IS NULL;

-- Direct lookup + sync
CREATE INDEX items_document_id_idx ON items (document_id)
  WHERE deleted_at IS NULL;

-- Optional: partial index for incomplete tasks
CREATE INDEX items_open_tasks_idx
  ON items (document_id, is_completed)
  WHERE type = 'task' AND deleted_at IS NULL AND is_completed = false;
```

**Why `rank` as `TEXT` (fractional indexing)?**
Integer `position` forces renumbering siblings on insert-between. Lexicographic ranks (`"a0"`, `"a0V"`, `"a1"`) let you insert between two siblings with a local string, which is ideal for concurrent offline clients and CRDT-friendly merges.

Libraries/patterns: fractional-indexing (Figma-style), or store a dense `numeric` and periodically rebalance.

***

### Closure table (optional but powerful)

```sql
CREATE TABLE item_closure (
  ancestor_id    UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  descendant_id  UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  depth          INT  NOT NULL CHECK (depth >= 0),
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (ancestor_id, descendant_id)
);

CREATE INDEX item_closure_descendant_idx
  ON item_closure (descendant_id, depth);

CREATE INDEX item_closure_ancestor_depth_idx
  ON item_closure (ancestor_id, depth);

-- Self rows: depth 0 for every item
```

**Maintain on write** (trigger or application service):

- **Insert child under P:** copy all ancestors of P, plus self row.
- **Delete / soft-delete:** remove closure rows for the subtree (or mark via join to `items.deleted_at`).
- **Move subtree:** delete old ancestor links for the subtree, reattach under new parent’s ancestors — the expensive case; batch carefully.

Use closure when:

- Breadcrumbs and “load full zoomed subtree” dominate.
- You inherit permissions down the tree.
- You need “is A under B?” constantly.

Skip it in v1 if every document stays small (< few thousand nodes) and recursive CTEs are enough.

***

### Postgres `ltree` as a read cache

```sql
CREATE EXTENSION IF NOT EXISTS ltree;

ALTER TABLE items ADD COLUMN path ltree;

CREATE INDEX items_path_gist ON items USING GIST (path);
```

Example path: `docid.item1.item2.item3` (encode UUIDs safely, e.g. base32 without dots).

- Subtree: `path <@ 'doc.abc'`
- Rebuild path on move (subtree update) — same class of cost as matpath.

**Pattern:** adjacency list is truth; `path`/`closure` updated asynchronously or in the same transaction for correctness.

***

## Mirrors and Multi-Parent (DAG)

Workflowy-style **mirrors** break a pure tree: one logical item appears under multiple parents.

Do **not** overload `parent_id` with multiple parents. Use:

```sql
CREATE TABLE item_refs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_id       UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_item_id  UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rank            TEXT NOT NULL,
  is_mirror       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_id, target_item_id)  -- optional: one mirror per parent
);

-- NOTE on UNIQUE(parent_id, target_item_id): this enforces "an item can be
-- mirrored under a given parent at most once" — the right default (two
-- identical mirror slots under one parent are noise, not a feature). Drop
-- this constraint only if you deliberately want duplicate refs to the same
-- target under one parent (e.g. multiple transclusion instances). The FK to
-- items uses ON DELETE CASCADE here (unlike items.parent_id) because a ref is
-- pure presentation state: when its target is GC'd, the dangling ref should
-- go with it. Refs are not part of the CRDT tree, so no tombstone is needed.

CREATE INDEX item_refs_parent_rank_idx
  ON item_refs (parent_id, rank);
```

**Client model:**

- Tree edges: `items.parent_id` (canonical placement).
- Mirror edges: `item_refs` (presentation + navigation).
- Editing content always updates `target_item_id`; structure of the mirror slot is local to the ref.

Backlinks can be a separate table or derived from `[[links]]` in content:

```sql
CREATE TABLE item_links (
  source_item_id  UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_item_id  UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL DEFAULT 'wiki', -- wiki | embed | mirror
  PRIMARY KEY (source_item_id, target_item_id, link_type)
);
```

***

## Tags, Dates, and Views

Keep the item row lean; attach attributes:

```sql
CREATE TABLE item_tags (
  item_id  UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag      CITEXT NOT NULL,  -- #project, @person
  PRIMARY KEY (item_id, tag)
);

CREATE INDEX item_tags_tag_idx ON item_tags (tag);

-- Parsed dates for calendar / recurring (Dynalist-like)
ALTER TABLE items
  ADD COLUMN due_at TIMESTAMPTZ,
  ADD COLUMN start_at TIMESTAMPTZ,
  ADD COLUMN recur_rule TEXT;  -- RRULE or app-specific
```

**Boards / tables** as views over the same tree:

```sql
CREATE TABLE views (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  root_item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  view_type    TEXT NOT NULL CHECK (view_type IN ('outline','board','table','calendar')),
  config       JSONB NOT NULL DEFAULT '{}'  -- column order, filters, sorts
);
```

Board columns can be **child items of a `type = 'board'` node**, or config-only metadata — prefer real items so offline and API stay uniform.

***

## Essential Query Patterns

### Immediate children (hot path)

```sql
SELECT *
FROM items
WHERE document_id = $1
  AND parent_id = $2
  AND deleted_at IS NULL
ORDER BY rank;
```

Index: `(document_id, parent_id, rank)` — this is your most important index.

### Ancestors (breadcrumbs) — recursive CTE

```sql
WITH RECURSIVE ancestors AS (
  SELECT id, parent_id, content, 0 AS depth
  FROM items
  WHERE id = $item_id
  UNION ALL
  SELECT i.id, i.parent_id, i.content, a.depth + 1
  FROM items i
  JOIN ancestors a ON i.id = a.parent_id
)
SELECT * FROM ancestors ORDER BY depth DESC;
```

With closure:

```sql
SELECT i.*
FROM item_closure c
JOIN items i ON i.id = c.ancestor_id
WHERE c.descendant_id = $item_id
ORDER BY c.depth DESC;
```

### Descendants (zoomed subtree)

Recursive CTE with depth limit for progressive loading:

```sql
WITH RECURSIVE tree AS (
  SELECT id, parent_id, rank, content, type, 0 AS depth
  FROM items
  WHERE id = $zoom_id AND deleted_at IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.rank, c.content, c.type, t.depth + 1
  FROM items c
  JOIN tree t ON c.parent_id = t.id
  WHERE c.deleted_at IS NULL AND t.depth < $max_depth
)
SELECT * FROM tree ORDER BY depth, rank;
```

Or via closure + join to `items` ordered by path/`rank` at each level (client often re-nests).

### Move subtree (adjacency list)

Single transaction:

1. Update moved root: `parent_id = $new_parent`, `rank = $new_rank`.
2. If using closure/`path`, recompute for moved root + all descendants.
3. Bump `version` / emit sync events.

No need to touch each descendant’s `parent_id` — only the root of the move changes. That is why adjacency list wins for outliners.

### Cycle prevention

```sql
-- Before setting parent_id = P for item N:
-- fail if P is N or a descendant of N
SELECT 1
FROM item_closure
WHERE ancestor_id = $n AND descendant_id = $p
-- or recursive CTE walk from P upward looking for N
```

Enforce in a `BEFORE UPDATE` trigger.

***

## Multi-Tenancy, Permissions, Sync

```sql
CREATE TABLE document_members (
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
  PRIMARY KEY (document_id, user_id)
);
```

- Always scope queries with `document_id` (and workspace) — never walk trees across docs without an explicit cross-link table.
- **Optimistic concurrency:** `version` column; API rejects stale patches (`WHERE id = $id AND version = $v`).
- **Soft deletes:** `deleted_at` so offline clients can tombstone and sync; hard-delete later via GC.

**Deletion & GC (important):**

Because deletes are soft, the `items.parent_id` foreign key uses `ON DELETE RESTRICT`, **not** `CASCADE`. A physical `CASCADE` would erase a subtree without writing tombstones, so offline replicas that never saw the delete would resurrect the rows on next sync (or diverge permanently). The delete path is therefore:

1. **User delete** → set `deleted_at` on the subtree root (mark descendants via closure/CTE, or mark the root only and treat descendants as implicitly deleted at read time). Emit a tombstone change so peers converge.
2. **GC (background, tombstone-aware)** → after a retention window (long enough that all known replicas have synced past the tombstone), hard-delete rows **bottom-up** (leaves first) inside a document advisory lock. Only GC issues physical `DELETE`s.

Never expose a raw `DELETE` on `items` to the application/API layer — it would race concurrent LWW move-ins (an item being moved *into* a subtree that is being physically deleted). Route everything through the soft-delete command.

- **Sync log** (optional):

```sql
CREATE TABLE item_changes (
  id           BIGSERIAL PRIMARY KEY,
  document_id  UUID NOT NULL,
  item_id      UUID NOT NULL,
  op           TEXT NOT NULL, -- insert|update|move|delete
  payload      JSONB NOT NULL,
  actor_id     UUID,
  client_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX item_changes_doc_id_idx ON item_changes (document_id, id);
```

Clients pull `WHERE id > $last_change_id`. Maps cleanly to Dynalist-style batch `doc/edit` patches.

If you use **Yjs**, you may also store:

```sql
CREATE TABLE yjs_updates (
  document_id  UUID NOT NULL,
  update       BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Relational `items` remain the **queryable projection** for search, tags, boards, and API; Yjs is the collab truth for rich text and fine-grained concurrent edits.

### Who writes the `items` rows? (Yjs → relational projection)

The report repeatedly says "project Yjs into Postgres" without naming the component that does it. It is a **server-side materializer**, and the cleanest place to host it is a **Hocuspocus `onStoreDocument` / `onChange` hook**:

```
Client edits ──► Yjs doc (authoritative structure + text)
                    │  (websocket, Hocuspocus)
                    ▼
        Hocuspocus onChange (debounced ~200–500ms)
                    │
                    ▼
        Materializer: diff Y.Map/Y.Array of items
        against last projected state → compute row upserts
                    │
                    ▼
        Postgres items (parent_id, rank, content, deleted_at)
        — the queryable projection
```

Concretely:

1. **Structure lives in a `Y.Map<itemId, {parentId, rank, ...}>`** (plus a `Y.Text` per item for rich content). The Yjs doc — not Postgres — is where LWW-parent and list-order merges resolve.
2. **Hocuspocus persists the raw Yjs updates** (the `yjs_updates` / binary-state blob) in its own store. That is the durable collab truth and is what a reconnecting client syncs against.
3. **A debounced hook materializes the projection.** On `onChange` (or `onStoreDocument`), the materializer reads the current `Y.Map`, diffs it against the last-projected snapshot for that document, and emits `INSERT ... ON CONFLICT DO UPDATE` for changed items + `deleted_at` for removed keys. Debounce so a burst of keystrokes produces one projection pass, not one per op.
4. **The projection is idempotent and rebuildable.** Because Postgres is downstream, you can drop and rebuild `items` for a document purely from the Yjs state — useful for migrations and for repairing a divergent projector. Never edit `items` as a way to change structure; that write would be silently overwritten on the next projection pass.
5. **Serialize projection per document** (advisory lock on `hashtext(document_id)`) so two Hocuspocus workers can't interleave upserts for the same doc.

This keeps the invariant from the *Conflict Resolution* section concrete: **CRDT (Yjs) decides, the materializer writes, Postgres records and validates.**

***

## Write Path Design (Application Layer)

Recommended service API (not raw SQL from the client):

| Command | Effect |
| :-- | :-- |
| `InsertItem(parent, afterRank, content)` | New row + rank between neighbors + closure rows |
| `UpdateItem(id, fields, version)` | Content/metadata only |
| `MoveItem(id, newParent, newRank)` | Relink + cycle check + closure/`path` fix |
| `DeleteItem(id)` | Soft-delete subtree (flag root or all via closure) |
| `MirrorItem(target, parent, rank)` | `item_refs` row |

Keep hierarchy mutations **serialized per document** (row lock on `documents` or advisory lock `hashtext(document_id::text)`) to avoid rank/closure races under multiplayer + offline replay.

***

## Performance Guidelines

1. **Document-scoped everything** — all hot indexes lead with `document_id`.
2. **Paginate / depth-limit** subtree loads; SPA loads children on expand, not 50k nodes at once.
3. **Prefer adjacency for writes**; add closure when ancestor/descendant queries show up in slow-query logs.
4. **Avoid nested sets** for this product class.
5. **Rebalance ranks** occasionally if fractional strings grow long.
6. **Partial indexes** on `deleted_at IS NULL` keep live working sets small.
7. For huge workspaces, **partition `items` by `document_id` hash** only after you measure need.

Empirical trade-off summary from hierarchical model studies: adjacency is best for local node ops; closure/materialized path trade write amplification for read speed; nested sets hurt under frequent structural edits.

***

## Full-Text Search

FTS is deferred to V2 but is specified here so the schema doesn't need reshaping later.

- **Column:** add `search_tsv tsvector` to `items`, populated from the plain-text projection of the item's content (extract text from the Yjs/rich content when materializing).
- **Maintenance:** generate it in the same materializer pass that writes `parent_id`/`rank`, or via a `GENERATED ALWAYS AS (to_tsvector('simple', content_text)) STORED` column if you keep a denormalized `content_text`. Prefer the generated column — it can't drift from the row.
- **Index:** `CREATE INDEX items_search_idx ON items USING GIN (search_tsv) WHERE deleted_at IS NULL;`
- **Scope every query by `document_id` / workspace** first, then rank with `ts_rank_cd`. Search is always tenant-scoped.
- **Config:** start with the `simple` dictionary (no stemming) for predictable outline search; move to language configs only if users ask. Store the config choice per workspace if you go multilingual.
- **Client-side offline search:** because the client already holds the working set in IndexedDB, do offline search locally (e.g. a small inverted index or `lunr`/`flexsearch` over cached items). Server `tsvector` handles cross-document / not-yet-loaded results when online.

```sql
ALTER TABLE items ADD COLUMN content_text TEXT;   -- plain-text projection
ALTER TABLE items ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_text, ''))) STORED;
CREATE INDEX items_search_idx ON items USING GIN (search_tsv)
  WHERE deleted_at IS NULL;
```

***

## Attachments & Images (offline sync)

S3 is in the stack but attachment offline behavior was unspecified. Attachments are **large binary blobs referenced by items**, and they sync on a different path than the text CRDT.

- **Model:** an `attachments` table (`id`, `document_id`, `item_id`, `s3_key`, `mime`, `size`, `checksum`, `uploaded_at`, `deleted_at`). Items reference attachments by id; the blob itself never enters the Yjs doc (CRDTs are for structured/text data, not megabyte binaries).
- **Offline capture:** when a user adds an image/file offline, store the blob in **IndexedDB** (or the Origin Private File System for larger files) with a client-generated attachment id, and insert the referencing item immediately. The item is fully usable offline pointing at the local blob.
- **Deferred upload queue:** maintain a persistent outbox of pending uploads. On reconnect, upload each blob to S3 (presigned PUT), then write the `attachments` row and flip the item's reference from the local blob URL to the `s3_key`. Use the client id as the durable key so retries are idempotent.
- **Download on demand:** when a peer receives an item referencing an attachment it doesn't have locally, it lazily fetches the blob from S3 (presigned GET) and caches it in IndexedDB. Don't block outline render on blob availability — show a placeholder until fetched.
- **Integrity & dedup:** content-hash (`checksum`) the blob; dedup identical uploads and detect corruption. Presigned URLs keep S3 credentials off the client.
- **Deletion:** attachment rows soft-delete with the item; the S3 object is removed by the same tombstone-aware GC after the retention window, so an offline client that re-adds a reference during the window doesn't hit a missing object.

***

## Recommended V1 vs V2

### V1 (ship the outliner)

- `workspaces` → `documents` → `items` with `parent_id` + `rank`
- Soft delete, `version`, tags, basic links
- Recursive CTEs for breadcrumbs and limited-depth trees
- Change log or Yjs updates for sync
- No closure table yet

### V2 (scale + Workflowy parity)

- `item_closure` or maintained `ltree path`
- `item_refs` for mirrors
- `views` for board/table
- Permission inheritance via closure
- Full-text search (`tsvector` on content) + tag indexes

***

## Mental Model

```text
Workspace
  └── Document
        └── Root Item (hidden)
              └── Item (parent_id + rank)  ← tree truth
                    ├── children...
                    ├── item_refs → mirrored targets  ← DAG edges
                    └── item_links → backlinks
        └── views (outline | board | table over a root_item)
```

**Source of truth for hierarchy:** adjacency list + fractional sibling order.
**Accelerators:** closure table and/or `ltree`.
**Non-tree relations:** explicit ref/link tables.
**Collab:** Yjs/patches projected into this schema for queryability.

That split is the durable way to support Dynalist-like multi-doc outlining, Workflowy-like zoom/mirrors/boards, and offline-first real-time sync without painting yourself into a nested-sets corner.

---

# Conflict resolution strategies for concurrent tree moves

The core pattern for your app is: **treat parent pointer + sibling order as CRDT/OT-managed registers per item, and make the database a projection of that merged state, not the primary conflict resolver.** For concurrent moves you then choose clear semantics (usually last-writer-wins on parent, plus a CRDT list for order) and enforce tree invariants (no cycles, unique node IDs) during merge.

Below is a deep dive on the main strategies and how they apply to an outliner.

***

## Why concurrent tree moves are hard

Typical conflict scenarios in an outliner:

- **Same node, different parents**
User A drags item X under A1; user B drags X under B1 at roughly the same time.
- **Same node, different positions under same parent**
A moves X above Y, B moves X below Z concurrently.
- **Move vs delete**
A moves X under B1, B deletes X or its old parent in parallel.
- **Move into descendant (cycle)**
Due to stale state, a client tries to move item X under one of its own descendants, which must be rejected or normalized.

For an offline-first, replicated tree you must guarantee:

1. **Convergence** – all replicas eventually see the same parent and order for every item.
2. **Safety** – the structure remains a tree/DAG (no cycles, no multi-root anomalies) unless you intentionally support mirrors.
3. **Intention-preserving enough** – users don’t see “teleporting” nodes that feel random, even if some conflicts resolve with last-writer semantics.

***

## Strategy 1: Server-authoritative OT on tree operations

Operational Transform (OT) is still widely used in production co-editors and handles conflicts by transforming operations before applying them on the server.

### How it works for moves

- Client sends `Move(node_id, old_parent, new_parent, old_pos, new_pos, base_version)`.
- Server holds canonical version; when new operations arrive, it transforms them against concurrent operations so that:
    - Parent changes and reorderings commute where possible.
    - Invalid moves (into deleted parents, into descendants) are transformed into safe no-ops or alternative positions.

### Pros

- Well-understood in industry; OT-based editors underpin many current Google Docs–style systems.
- You can enforce tree invariants centrally and reject/transform bad moves.

### Cons

- Requires a **central coordinator**; harder to do fully peer-to-peer or local-first without a canonical server.
- OT for complex trees is much more involved than OT for plain text; you end up re-implementing logic that modern tree CRDT algorithms already address.

For your offline-first vision, pure OT is less attractive; however, **“OT-like logic inside your server”** (version checks + small transformations) is still useful as a pragmatic layer on top of simpler merge semantics.

***

## Strategy 2: CRDTs with LWW parent register + CRDT list order

Modern CRDT treatments of lists and trees often use **per-node registers** for parent and position, and make them last-writer-wins (LWW) under a deterministic tie-break rule.

### Basic idea

For each item `i`:

- `parent_i` is a LWW register keyed by `(timestamp, replica_id)` → last causal write wins, with a deterministic tie-breaker.
- `position_i` is a CRDT list element identifier (e.g., RGA/Treedoc-like) within `parent_i`’s child list.

A move becomes:

1. Write `parent_i := new_parent` with a higher timestamp than any previous parent write.
2. Write `position_i := new_position_identifier` in the child list CRDT of `new_parent`.

### Conflict semantics

- **Concurrent move to A1 and B1** → both replicas eventually converge to one parent (whoever’s LWW wins), and the loser’s move is effectively ignored.
- **Concurrent reorders under same parent** → list CRDT (e.g. an ordered tree CRDT) ensures a deterministic order by comparing position identifiers; no operation is “lost”, just interleaved.
- **Move vs delete** → if delete wins on `parent_i` or on the node itself, the item may be tombstoned; if move wins, item survives but old parent being deleted is harmless.

### Tree invariants

Tree CRDT work (Nair/Shapiro, Kleppmann et al.) shows how to ensure **acyclicity** and convergence even with arbitrary concurrent moves, typically by:

- Rejecting or rewriting moves that would create cycles.
- Carefully defining when a move is “safe” and when it must be rolled back or turned into a no-op.

The “CRDTs: The Hard Parts” analysis explicitly notes that you can model parent as a LWW register per list item, with convergence guaranteed but at the cost of choosing one destination deterministically.

### Pros / Cons

- Pros:
    - Fully **coordination-free**; replicas can merge states without talking to a server.
    - Fits local-first and P2P topologies naturally.
- Cons:
    - User intent is not always preserved; one of two concurrent moves “wins”.
    - Implementing a general tree CRDT correctly is non-trivial without a library.

For your app, a practical variant is: **Yjs/JSON-CRDT for the collaborative document, with parent pointer / child order expressed in CRDT state, then projected into Postgres.** Libraries like Loro and JSON CRDT extensions already implement move semantics for hierarchical JSON.

***

## Strategy 3: Dedicated move operations for replicated trees (Kleppmann’s algorithm)

Kleppmann et al. present a specific CRDT algorithm for moves on replicated trees that preserves invariants and converges without coordination.

Key properties:

- Designed for **distributed filesystems and tree-shaped JSON/XML**, which match your outliner’s tree.
- Supports arbitrary concurrent moves while guaranteeing:
    - No cycles are introduced.
    - All replicas converge to the same structure.
- Formally verified using proof assistants and evaluated in geo-replicated settings.

This algorithm essentially defines **move operations with additional metadata** so that when concurrent moves occur, you can decide which move “wins” or how to compose them, while maintaining invariants.

Several newer tree CRDTs and local-first libraries build on these ideas or similar semantics for “movable trees”.

### Practical implication

Instead of inventing your own move resolution logic, you can:

- Use a JSON/tree CRDT library that implements Kleppmann-style moves (e.g., Loro’s movable tree CRDT, Outl’s tree CRDT).
- Treat the CRDT document as authoritative for structure; your relational schema (adjacency list + closure) is just a **materialized view**.

That gives you robust conflict resolution “for free” and lets you focus on features.

***

## Strategy 4: Mirror semantics for conflicting moves

One alternative user-facing strategy is: **when two users move the same node to different parents concurrently, treat the conflict as creation of a mirror** (multi-parent).

Semantics:

- When merge sees two parents for item X at the same logical time, instead of picking one, you:
    - Keep one as canonical parent.
    - Create a mirrored reference under the other parent (your `item_refs` DAG), marking it as a mirror.

Pros:

- Users don’t “lose” either move; they see X in both places, which often matches their intention to reuse content across projects.
- Fits Workflowy’s concept of mirrors and some tree CRDTs that allow multi-parent (DAG) structures.

Cons:

- More complex semantics; you must explain mirrors clearly in the UI.
- Some invariants change: your structure is now a DAG, not a pure tree, so algorithms relying on tree assumptions must be updated.

This can be a nice differentiator: **LWW for parent in strict-tree mode, mirror-on-conflict in “multi-parent mode”**, both implemented on top of a CRDT engine.

***

## Strategy 5: DB-level optimistic concurrency + application-level rules

If you treat CRDT/OT as too heavy for the tree itself, you can implement **simpler conflict resolution at the application/database layer**, especially if you still have a central server:

- Each `items` row has a `version` or `updated_at`.
- Move request includes the client’s known version.
- Server logic:
    - If no conflict: apply move (`parent_id`, `rank` update).
    - If conflict (version changed since client): apply a rule:

Example rules:

1. **Last-writer-wins parent, stable order**
    - If parent changed concurrently, choose the more recent server-side write and reject/override older one.
    - Recompute sibling order deterministically based on timestamps and fractional rank.
2. **“First writer wins, second move becomes mirror”**
    - If parent differs, accept first move, turn second into mirror.
3. **Cycle guard**
    - Before commit, check via closure or recursive CTE whether new parent is a descendant; if so, reject move or re-root the cycle node.

This isn’t as mathematically elegant as CRDT-based moves, but for many apps with a central backend it’s enough, and you still get **eventual consistency** assuming all clients talk to the same authoritative DB.

You can combine this with Yjs/Yjs-like CRDTs managing *content* while the tree structure is handled centrally.

***

## OT vs CRDT for your use case

OT and CRDT both provide eventual consistency but differ in how they handle operations:

- **OT**: transforms operations against each other on receipt to preserve intentions; traditionally needs a central coordinator.
- **CRDT**: designs operations or state such that merges are commutative; no central coordinator is required, and it fits local-first/P2P better.

Recent surveys highlight that CRDT-based move operations are now well-understood for trees, even though OT is still dominant in many text co-editors. Given your **offline-first, open-source, self-hosted** goals, CRDTs (particularly JSON/tree CRDT implementations) are a better long-term fit.

***

## Recommended approach for your outliner

Given everything above, a pragmatic strategy for you would be:

1. **Use a tree/JSON CRDT implementation that already supports move**
    - E.g., Loro’s movable tree, Outl’s tree CRDT, or a JSON CRDT extended with move operations per recent work.
    - Let it manage parent pointers and sibling order with LWW semantics and CRDT list identifiers.
2. **Define semantics for concurrent moves**
    - Default to **last-writer-wins parent**, CRDT-based sibling order, with a clear tie-break rule (timestamp + replica ID).
    - Optionally, in a “mirror mode”, treat conflicting parents as triggers to create mirrors instead of choosing one.
3. **Enforce invariants in the CRDT layer and in the DB projection**
    - No cycles: reject/normalize moves that would create cycles, using ancestor checks (closure table or CTE) when projecting to Postgres.
    - Unique IDs and DAG structure if you support mirrors.
4. **Treat Postgres as a projection of CRDT state**
    - On server merge, write `parent_id`, `rank` and other fields into your `items` table; if conflicts were resolved at CRDT level, DB never sees inconsistent states.
5. **Surface user-understandable outcomes**
    - If their move lost due to concurrency, show activity history or a small “conflict resolution” note so it doesn’t feel arbitrary.
    - If a mirror was created, visually distinguish it as “this item also lives here.”

**Reconciling “Postgres as projection” with the DB triggers/constraints.** These two framings look contradictory but are not — they operate at different layers, and the boundary is the write path:

- **The CRDT layer is the only conflict resolver.** All concurrent-edit resolution (LWW parent, list-CRDT order, cycle rejection on move) happens *before* anything touches Postgres. The server merges the CRDT, then writes the already-resolved `parent_id`/`rank` into `items`.
- **Postgres constraints/triggers are integrity guards on an already-resolved write, never a second resolver.** The partial unique index (one root/doc), the FK `RESTRICT`, and any closure-maintenance trigger exist to catch *bugs in the projector* — they must never be the thing that decides a conflict. If a trigger would reject a projected write, that is a projector defect to fix, not a conflict to arbitrate in SQL.
- **No cascades, no DB-side deletes.** Because the DB is downstream of merge, it must not take autonomous structural actions. That is exactly why `parent_id` is `RESTRICT` (not `CASCADE`) and why physical deletes are confined to the tombstone-aware GC job (see *Deletion & GC* above). The race “cascade delete vs concurrent LWW move-in” cannot occur if the DB never cascades and merge already ordered the two ops.

In short: **CRDT decides, Postgres records and validates.** Keep every write on the projector path; never let application code or a trigger mutate structure out from under the CRDT.

This path lets you lean on solid research and libraries rather than rolling your own move semantics, while keeping your relational schema simple and efficient.

If you want, I can next map these strategies onto concrete API shapes (e.g., what your `MoveItem` RPC looks like with CRDT vs DB-level resolution, and how to expose resolution outcomes to the client).

---

# Implementing Fractional Indexing for Item Ordering

Fractional indexing lets you insert or move an outline item **between two siblings by updating only that item’s order key**—no renumbering of neighbors. That matches drag-and-drop outliners, offline clients, and LWW merge of a `rank` field.

For your schema, `items.rank TEXT` (lexicographic order under a parent) is the practical choice.

***

## The Problem Integer Positions Create

Classic approach:

```text
rank: 0, 1, 2, 3, 4
```

Insert between `1` and `2` → either:

- shift everyone (`2→3, 3→4…`), or
- use gaps (`0, 10, 20…`) until gaps run out.

Both fail under concurrent multiplayer and offline queues: many rows touch on every insert, and two clients inventing “the same gap” collide.

**Goal:** a totally ordered key space where for any adjacent keys $a < b$ you can always compute $c$ with $a < c < b$, preferably without rewriting other rows.

***

## Float Midpoints (Figma’s first idea) — and why not

Figma’s multiplayer posts describe indices as fractions in $(0, 1)$; insert = midpoint.

```text
0.3 ----insert---- 0.4  →  0.35
```

**Fails in practice:**

| Issue | Effect |
| :-- | :-- |
| IEEE-754 precision | Midpoints eventually equal neighbors in JS/DB floats |
| Key growth | Repeated midpoints produce long binary fractions |
| Boundaries | If you allow 0 or 1, you cannot insert before first / after last forever |

So production systems moved to **arbitrary-precision string keys** that sort lexicographically.

***

## String Fractional Indexing (recommended)

### Core idea

- Store `rank` as a **string**.
- Sort with normal string comparison (`ORDER BY rank`).
- `generateKeyBetween(a, b)` returns a string strictly between `a` and `b` (or before/after if one side is null).

Common encodings:

1. **Digits / base-N strings** (Rocicorp `fractional-indexing`, Greenspan-style).
2. **Figma-style**: drop `0.`, encode fractional part in a large printable alphabet (~95 chars) so keys stay short.
3. **Lexorank** (Atlassian-style): bucket + fractional part, periodic rebalance.

For Node + Postgres, **Rocicorp-compatible string keys** (or jittered variants) are the usual pick.

### Mental model

```text
null  <  "a0"  <  "a0V"  <  "a1"  <  "a2"  <  null
         ↑ insert between a0 and a1 → "a0V"
```

`null` left bound = “before first”; `null` right bound = “after last”.

***

## Algorithm Sketch

### 1. Character set

Pick a totally ordered alphabet, e.g. base-62:

```text
0-9 A-Z a-z
```

Or the Figma printable set. **Never** change alphabet after shipping without migration.

### 2. Midpoint with length control

Given neighbors `a` and `b` (same length after padding rules):

- Find first differing position.
- Take midpoint of that digit.
- Prefer **shorter** results: if `"3"` and `"6"` → `"5"`, not `"45"`.
- If digits are adjacent (`"3"`, `"4"`), append a midpoint digit → `"35"`.

Prefix handling:

```text
a = "123"
b = "1234"   → pad a as "1230…", midpoint on the differing suffix
```

Implementations document exact padding (trailing zeros vs sentinel max).

### 3. Append / prepend without midpoint blow-up

Always mid-splitting at the **end** of the list makes keys longer exponentially.

Better policy:

| Case | Strategy |
| :-- | :-- |
| Insert at end | Increment last “integer-like” segment (`…`, `a0`, `a1`, `a2`) |
| Insert at start | Decrement or use smaller first segment |
| Insert between | Midpoint only |

That keeps common “add bullet below” paths short.

### 4. API surface

```ts
// Pseudocode — use a library in production
generateKeyBetween(a: string | null, b: string | null): string
generateNKeysBetween(a: string | null, b: string | null, n: number): string[]
```

Outliner operations:

| UX action | Call |
| :-- | :-- |
| New child at end | `generateKeyBetween(lastChild.rank, null)` |
| New child at start | `generateKeyBetween(null, firstChild.rank)` |
| Insert after X | `generateKeyBetween(X.rank, nextSibling?.rank ?? null)` |
| Drag between L and R | `generateKeyBetween(L.rank, R.rank)` |
| Move under new parent | same as insert at target slot + update `parent_id` |

***

## Concurrent Inserts: Collisions and Jitter

### Collision case

Two offline clients both insert between `A` and `B` and both compute the **same** midpoint → same `rank`.

### Mitigations

**A. Random jitter (preferred for offline-first)**
After computing the ideal midpoint range, pick a random key inside the open interval (or binary-split with random bits).

`jittered-fractional-indexing` (built on Rocicorp) repeatedly bisects and flips coins for $b$ bits of entropy; collision probability estimated via birthday bound.

```text
P(collision) ≈ k² / 2^(b+1)   for k concurrent keys, b jitter bits
```

Default ~30 bits is usually plenty for outline siblings.

**B. Allow collision + deterministic tie-break**
Order by `(rank, replica_id)` or `(rank, item_id)`. Same rank is legal; total order still defined.

**C. Server authority**
On unique violation or detected clash, server slightly offsets the key so it no longer collides.

**Recommended combo for your app:**

1. Client generates **jittered** key.
2. Unique constraint is **optional** on `(parent_id, rank)`; prefer unique on `item_id` only.
3. Display order: `ORDER BY rank, id`.
4. On pathological equality, optional server nudge.

That keeps LWW-on-`rank` simple when merging concurrent moves.

***

## Interleaving (semantic wart)

Fractional indexing does **not** preserve “run of inserts” as a block under concurrency.

Example: user P types three bullets, user Q types three between the same bounds; after merge order can **interleave** (`P1 Q1 P2 Q2…`) instead of `P1 P2 P3 Q1 Q2 Q3`.

For outliners this is often acceptable (same class of issue Figma noted for object lists).
If you need “session-contiguous” inserts, you need richer CRDT list types (RGA, Fugue, etc.) or attach a **session/run id**—not plain fractional keys alone.

***

## Postgres Integration

### Schema

```sql
-- under each parent, order by rank then id
rank  TEXT NOT NULL,

CREATE INDEX items_parent_rank_idx
  ON items (document_id, parent_id, rank, id)
  WHERE deleted_at IS NULL;
```

Do **not** use `NUMERIC` for string-style keys; use `TEXT`.
Avoid unique `(parent_id, rank)` if you allow jitter collisions; use `(rank, id)` for sort stability.

### Write path

```ts
async function insertBetween(parentId: string, afterId: string | null, content: string) {
  const siblings = await listChildren(parentId); // ordered by rank, id
  const after = afterId ? siblings.find(s => s.id === afterId) : null;
  const afterIdx = after ? siblings.indexOf(after) : -1;
  const left = afterIdx >= 0 ? siblings[afterIdx].rank : null;
  const right = afterIdx >= 0 ? siblings[afterIdx + 1]?.rank ?? null
                              : siblings[0]?.rank ?? null;

  // end insert: left = last.rank, right = null
  const rank = generateJitteredKeyBetween(left, right);

  return db.insert(items, { parent_id: parentId, rank, content, version: 1 });
}
```

### Move

```ts
async function moveItem(itemId: string, newParentId: string, afterId: string | null) {
  // cycle check first (closure / CTE)
  const rank = /* generate between neighbors under newParent */;
  await db.update(items, itemId, {
    parent_id: newParentId,
    rank,
    version: sql`version + 1`,
  });
}
```

Only the moved row’s `rank` (and `parent_id`) change—subtree descendants keep their relative ranks under the moved root.

### Validation

- Reject empty rank.
- Optionally assert `left < rank < right` when both bounds known (debug builds).
- Max length guard (e.g. 512 chars); if exceeded → **rebalance** that sibling list.

***

## Key Growth and Rebalancing

Repeated midpoint inserts in a tight gap lengthen strings.

**When to rebalance**

- Any sibling’s `rank.length > threshold` (e.g. 50–100).
- Or periodic job per hot parent.

**How**

In one transaction, for children of `P` ordered by `(rank, id)`:

```text
assign fresh short keys: a0, a1, a2, …  (or evenly spaced in key space)
```

Caveats:

- Touches many rows → bad if done naively under multiplayer; use document advisory lock.
- Offline clients holding old ranks must accept LWW/`version` updates (or CRDT merge) so rebalance doesn’t fight them.
- Prefer rebalance **only that parent’s children**, not whole document.

Append-heavy workloads that use “increment at end” rarely need global rebalance.

***

## CRDT / Sync Interaction

Fractional index is **not** a full list CRDT by itself. Common patterns:

| Layer | Role of `rank` |
| :-- | :-- |
| **LWW register** | Concurrent moves: last `rank`+`parent` write wins; order ties by `id` |
| **Yjs / list CRDT** | CRDT owns order; `rank` is a **projection** for SQL queries |
| **Hybrid** | Yjs for rich text; fractional `rank` for outline structure |

For tree moves (previous topic): update `parent_id` + new fractional `rank` under the destination parent in one logical op; merge with LWW or tree-CRDT move semantics.

Jitter lowers same-rank collisions when two clients LWW-merge different midpoints.

***

## Reference Implementation Choices

| Library / approach | Notes |
| :-- | :-- |
| [rocicorp/fractional-indexing](https://github.com/rocicorp/fractional-indexing) | JS/TS standard; `generateKeyBetween` / `generateNKeysBetween` |
| jittered-fractional-indexing | Adds entropy for concurrent offline inserts |
| Python / Rust / Go ports | Same algorithm family for server-side generation |
| Lexorank variants | Extra structure + rebalance conventions |

**Do not hand-roll midpoint logic in production** unless you have tests against known vectors; off-by-one padding bugs silently corrupt order.

***

## Concrete TypeScript Shape (illustrative)

```ts
import { generateKeyBetween } from 'fractional-indexing';
// or jittered variant

export function rankForInsert(
  ordered: { id: string; rank: string }[],
  afterId: string | null
): string {
  if (ordered.length === 0) {
    return generateKeyBetween(null, null); // first key in space
  }
  if (afterId === null) {
    // insert at start
    return generateKeyBetween(null, ordered[0].rank);
  }
  const i = ordered.findIndex((x) => x.id === afterId);
  if (i < 0) throw new Error('afterId not in sibling list');
  const left = ordered[i].rank;
  const right = i + 1 < ordered.length ? ordered[i + 1].rank : null;
  return generateKeyBetween(left, right);
}
```

Server should re-load siblings (or trust signed bounds from client carefully) so ranks stay consistent with DB truth under concurrency.

***

## Testing Checklist

1. **Empty list** → first key.
2. **Append N times** → keys stay short / monotonic.
3. **Prepend N times** → still ordered.
4. **Binary insert hammer** (always insert between first two) → length grows but order holds; rebalance recovers.
5. **Concurrent same-gap inserts** (parallel jitter) → no invariant break; `ORDER BY rank, id` stable.
6. **Move across parents** → only one row’s rank/parent changes; cycle check still required.
7. **Lexicographic == SQL** → Postgres `C` collation or ensure rank charset is byte-order safe (`C` / `POSIX` collation on `rank` if DB collation is locale-tricky).
```sql
-- safest for opaque keys
rank TEXT NOT NULL COLLATE "C"
```

***

## How This Fits Your Outliner Stack

```text
items.parent_id     → tree structure
items.rank (TEXT)   → sibling order via fractional indexing
ORDER BY rank, id   → stable total order
jitter on generate  → offline multiplayer
rebalance (rare)    → bound key length
CRDT/LWW on rank    → concurrent move resolution (with parent)
```

**V1:** Rocicorp (or jittered) keys, `TEXT COLLATE "C"`, sort `(rank, id)`, no unique on rank.
**V2:** optional rebalance worker; optional projection from Yjs/list CRDT if you need stronger non-interleaving guarantees.

***

## Summary

| Concern | Practice |
| :-- | :-- |
| Storage | `TEXT` fractional keys, not floats/ints |
| Insert/move | `generateKeyBetween(left, right)` on one row |
| Concurrency | Jitter + tie-break `(rank, id)` |
| Growth | End-increment policy + rare sibling rebalance |
| Limits | Interleaving under concurrent multi-insert; not a full list CRDT |
| DB | Index `(document_id, parent_id, rank, id)`; `COLLATE "C"` |

That is the standard, production-proven way to implement sibling ordering for a Dynalist/Workflowy-class tree without rewriting the whole list on every drag.

If you want a next deep dive, the natural sequel is **sibling rebalance algorithms + migration without breaking offline clients**, or a **worked Node/Postgres module** (`rank.ts` + SQL) wired to your `MoveItem` / `InsertItem` commands.

---

# Strategies for Lexicographical Index Collisions in Offline Sync

In an offline-first outliner, two devices often invent a **sibling order key** (`rank`) between the same bounds without seeing each other. Identical (or effectively identical) ranks are normal; the system must still **converge**, stay **sortable**, and keep **inserts possible** between collided rows.

Treat `rank` as an **LWW register** (or CRDT field), never as a globally unique position. Uniqueness lives on `item_id`; total order is `(rank, tie_break)`.

***

## What “collision” means

| Kind | Example | Severity |
| :-- | :-- | :-- |
| **Exact string equality** | Both clients get `"a0V"` between `"a0"` and `"a1"` | Common without jitter |
| **Logical same slot** | Same bounds, different jitter keys still “between A and B” | Not a bug |
| **Sort instability** | Same `rank`, order flips by client | Bad UX if no stable tie-break |
| **No room to insert** | Adjacent equal ranks + naive midpoint fails | Must open space |
| **DB unique violation** | `UNIQUE(parent_id, rank)` | Avoid this constraint |

Collisions are a **distributed ordering** problem, not a DB integrity problem—unless you force uniqueness on `rank`.

***

## Strategy 1: Allow collisions + stable total order (baseline)

**Rule:** equal ranks are legal. Sort:

```text
ORDER BY rank ASC, replica_id ASC, item_id ASC
-- or simply: ORDER BY rank, id
```

When peers $P$ and $Q$ both create items with the same order values, merge keeps all rows and orders the lesser peer first (or lesser `item_id`).

```text
A [1, P]
X [1, Q]   -- same rank as A
B [2, P]
Y [2, Q]
```

**Pros**

- Works offline and P2P; no coordination to “claim” a slot.
- Matches LWW on the order field: last write updates `rank`; ties never break the model.
- Simple Postgres projection: no unique on `(parent_id, rank)`.

**Cons**

- Concurrent multi-bullet runs can **interleave** (`P1 Q1 P2 Q2…`).
- Insert-between two equal-rank neighbors needs care (Strategy 3).

**Schema**

```sql
rank TEXT NOT NULL COLLATE "C",
-- NO unique (parent_id, rank)
CREATE INDEX ON items (document_id, parent_id, rank, id)
  WHERE deleted_at IS NULL;
```

**This should be your default.** Every other strategy builds on it.

***

## Strategy 2: Jitter at generation time (reduce collision rate)

Before sync, generate keys **inside** $(a,b)$ with random entropy so concurrent midpoints rarely match.

### How jitter works (binary split)

1. Compute unjittered midpoint $m$ between $a$ and $b$.
2. With 50% probability, recurse into $(a,m)$ or $(m,b)$.
3. Repeat for $b$ bits → $O(b)$ calls to `generateKeyBetween`.

### Birthday bound

For $k$ concurrent keys in the **same** $(a,b)$ gap with $b$ jitter bits:

$$
P(\text{collision}) \approx 1 - \frac{(2^b)!}{(2^b - k)! \,(2^b)^k}
$$

Rough guide (same gap, concurrent):

| Jitter bits | Concurrent keys $k$ | Collision chance (order of) |
| :-- | :-- | :-- |
| 30 | 100 | negligible |
| 30 | 10 000 | ~4.5% |
| 40+ | large bursts | still low |

**Practice**

- Default **~30 bits** for outline siblings; raise for bulk import / paste of huge lists into one gap.
- Prefer CSPRNG (`crypto.getRandomValues`) over `Math.random` if you care about adversarial collision (usually overkill for ranks).
- Jitter **increases key length** slightly; still cheaper than full rebalance.

**Important:** jitter **reduces** collisions; it does not eliminate them. Always keep Strategy 1.

***

## Strategy 3: Open space when inserting between collided ranks

When left and right bounds have the **same** `rank` (or are equal after tie-break adjacency), a plain midpoint may be impossible or unstable.

**On insert between collided neighbors:** nudge collided items (or only the right cluster) by a fraction to create a gap, then place the new key in the opened interval.

```text
Before (collided):
  A [1, P]
  X [1, Q]

Insert NEW between A and X:
  A     [1,   P]
  NEW   [1.5, P]    -- or string midpoint after opening
  X     [1.75, Q]   -- X moved slightly "up"
```

This preserves LWW semantics on the order field and does not invent a new CRDT type.

**Implementation notes**

- Prefer **local** opens: only adjust ranks that share the exact collision key under that parent.
- Emit those adjustments as normal LWW rank updates (with timestamps) so offline peers converge.
- Under a central server, open-space can run only on the sync authority; clients then pull new ranks.

**When to trigger**

```ts
if (left.rank === right.rank || !canGenerateStrictBetween(left.rank, right.rank)) {
  openSpace(parentId, left, right); // rewrite small cluster
}
generateKeyBetween(left.rank, right.rank);
```

***

## Strategy 4: Explicit composite order key (encode tie-break in the string)

Some systems append a **site id / counter** so the stored string rarely collides even if the fractional prefix matches:

```text
rank = <fractional> + "#" + <replica_id> + ":" + <lamport>
// sort still lexicographic if separator and encoding are careful
```

Or keep two columns:

```sql
rank        TEXT NOT NULL,  -- fractional, may collide
rank_tie    TEXT NOT NULL,  -- replica_id or ulid
-- ORDER BY rank, rank_tie
```

**Pros:** deterministic, no random jitter required for uniqueness of the **composite**.
**Cons:** longer keys; must define encoding so `#replica` does not break midpoint math (usually: midpoint only on fractional prefix; tie is not mid-pointed).

Common pattern in CRDT fractional demos: position + **object id as tie-breaker** outside the fraction.

***

## Strategy 5: Server (or sync leader) allocation / nudge

Useful when you have a **primary sync server** (your Node + Postgres design) even if clients are offline-first.

### 5a. Accept client rank, fix on commit

```text
Client proposes rank R
Server: if another live sibling under parent has rank R
        → assign R' = generateKeyBetween(R, next) or jitter until free
        → return rewritten rank to client
```

### 5b. Optional soft uniqueness

```sql
-- usually SKIP unique on rank; if you insist:
UNIQUE NULLS NOT DISTINCT (parent_id, rank)  -- then retry loop
```

Retry loop on unique violation is a last resort; it fights offline multiplayer and is weaker than allow-collision + tie-break.

### 5c. Authoritative child list

Server stores order as a CRDT list or array of ids; fractional ranks are a **cache**. Collisions never appear in the source of truth—only in the projection. Heavier, but cleanest for “Google Docs–grade” lists.

For Dynalist-like scale, **5a without unique constraint** is enough if clients already jitter.

***

## Strategy 6: LWW merge rules for the rank field

Offline sync must define how two versions of the **same item** merge when both changed `rank` / `parent_id`.

### Per-item LWW (recommended baseline)

```text
if remote.rank_wallclock > local.rank_wallclock → take remote rank
else if equal clock → tie-break by replica_id
```

Parent and rank should share one **move clock** (or same version vector entry) so you do not apply parent from A and rank from B inconsistently.

### Tombstones / delete vs move

- If item is deleted (tombstone) with higher clock → drop or keep tombstone; rank irrelevant.
- If move wins over delete depending on your product rules—pick one and stick to it.

### Different items, same rank

No merge of the rank **values** across items—only sort-time tie-break (Strategy 1). Do not “average” two items’ ranks on sync.

***

## Strategy 7: CRDT list instead of bare fractional ranks

If collisions + interleaving become product-visible (e.g. collaborative typing of many bullets):

| Approach | Collision handling | Interleaving |
| :-- | :-- | :-- |
| Fractional + jitter + tie-break | Rare / allowed | Possible |
| Fractional + open-space | Handled on insert | Still possible |
| RGA / Yjs YArray / Fugue-style list | Structural | Much better for runs |
| Recursive ordering (parent-relative CRDT) | Designed for trees | Stronger semantics |

vlcn notes: to **fix** interleaving you eventually leave pure fractional indexing for recursive/list CRDT ordering; some schemes encode recursive relationships back into a key string.

**Hybrid for your app**

- **Outline structure:** fractional `rank` + Strategies 1–3 + LWW move.
- **Rich text inside a bullet:** Yjs.
- **Later:** YArray / tree CRDT as source of truth; SQL `rank` as projection.

***

## Strategy 8: Rebalance as collision / length escape hatch

When a gap is exhausted, keys are huge, or a parent has a large equal-rank cluster:

1. Lock document or parent (advisory lock).
2. Read children `ORDER BY rank, id`.
3. Assign fresh short keys `a0, a1, a2…` (or evenly spaced).
4. Bump move clocks so LWW prefers rebalanced ranks.
5. Broadcast as a **rebalance op** or per-row LWW updates.

Offline clients that still hold old ranks lose on LWW—acceptable if rebalance is rare and versioned.

Do **not** rebalance on every collision; only on thresholds (max key length, cluster size).

***

## End-to-end offline sync policy (recommended stack)

```text
┌─────────────────────────────────────────────────────────┐
│ GENERATE (client, offline)                              │
│  rank = jitteredGenerateKeyBetween(left, right)         │
│  meta = { clock, replica_id }                           │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ LOCAL STORE                                             │
│  allow duplicate ranks under parent                     │
│  UI order: sort(rank, replica_id|id)                    │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ MERGE (sync engine)                                     │
│  same item_id: LWW(parent, rank) by clock               │
│  different item_id, same rank: keep both (no rewrite)   │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ INSERT BETWEEN AFTER MERGE                              │
│  if bounds equal / no strict between → openSpace()      │
│  then generateKeyBetween                                │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ SERVER PROJECTION (Postgres)                            │
│  no UNIQUE(parent_id, rank)                             │
│  optional nudge only if you want "prettier" keys        │
│  ORDER BY rank COLLATE "C", id                          │
└─────────────────────────────────────────────────────────┘
```

***

## Client algorithm (concrete)

```ts
type Bounds = { rank: string; id: string };

function cmpOrder(a: Bounds, b: Bounds): number {
  if (a.rank < b.rank) return -1;
  if (a.rank > b.rank) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortSiblings(items: Bounds[]) {
  return [...items].sort(cmpOrder);
}

function allocateRank(
  siblings: Bounds[], // already sorted
  afterId: string | null,
  jitterBits = 30
): string {
  let left: string | null = null;
  let right: string | null = null;

  if (afterId == null) {
    right = siblings[0]?.rank ?? null;
  } else {
    const i = siblings.findIndex((s) => s.id === afterId);
    left = siblings[i]?.rank ?? null;
    right = siblings[i + 1]?.rank ?? null;
  }

  // Collided or adjacent equal ranks under tie-break adjacency
  if (left != null && right != null && left >= right) {
    // openSpace mutates local siblings' ranks (LWW ops) then refresh left/right
    ({ left, right } = openSpaceAndGetBounds(siblings, afterId));
  }

  return generateJitteredKeyBetween(left, right, jitterBits);
}
```

`openSpaceAndGetBounds` implements Strategy 3: slightly increase ranks of the right-hand collision cluster so `left < right` lexicographically.

***

## Sync payload shape

```json
{
  "op": "upsert_item",
  "item_id": "…",
  "parent_id": "…",
  "rank": "a0V7xK…",
  "rank_clock": { "replica": "device_3", "lamport": 1842 },
  "content_clock": { "replica": "device_3", "lamport": 1840 }
}
```

Keep **content** and **position** clocks separate so editing text does not stomp a concurrent move (and vice versa), unless you intentionally version the whole row together.

***

## Testing matrix for offline collision

| Scenario | Expectation |
| :-- | :-- |
| Two devices insert one bullet in empty doc | Both kept; order by `(rank, id)` stable after merge |
| Both insert between same A–B without jitter | Possible equal rank; both visible; sorted by id |
| Both insert with 30-bit jitter | Almost always distinct ranks |
| Insert between two equal-rank siblings | openSpace then insert; no throw |
| LWW: device1 moves item, device2 moves same item | One parent+rank wins; tree stays acyclic (separate check) |
| Rebalance while offline edit pending | Higher clock wins; client reapplies or drops stale rank |
| Bulk paste 500 rows offline in one gap | Use `generateNKeysBetween` + jitter or pre-split gaps; avoid 500 identical midpoints |

***

## What not to do

- **Unique `(parent_id, rank)`** as the main defense — breaks offline multiplayer.
- **Float ranks** — precision collapse looks like permanent collision.
- **Assume jitter ⇒ zero collisions** — birthday bound says otherwise at scale.
- **Midpoint without open-space** when `left === right` — generator may throw or return invalid keys.
- **Merge by averaging ranks** of different items — destroys intent and LWW clarity.

***

## Practical recommendation for your successor app

| Layer | Choice |
| :-- | :-- |
| Generation | Jittered fractional keys (~30 bits; more for bulk) |
| Storage | Duplicate ranks allowed; `ORDER BY rank, id` |
| Merge | LWW on `(parent_id, rank)` with shared move clock |
| Equal bounds | Open space, then insert |
| Server | Project only; optional cosmetic nudge; no hard unique on rank |
| Escape hatch | Per-parent rebalance on length/cluster thresholds |
| Future | List/tree CRDT if interleaving becomes a product issue |

That combination is what production fractional-indexing writeups describe for distributed SQLite/CRDT systems: **jitter to make collisions rare, allow and order collisions when they happen, open space when you must insert between them, and keep LWW simple.**

If you want a follow-on, the next piece is a precise **`openSpace` algorithm** (minimal rank rewrites, clock assignment, and how many siblings to touch under a parent).
