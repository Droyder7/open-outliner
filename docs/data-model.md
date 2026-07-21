# 03 — Data Model

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

The relational model is the **queryable projection** of the Yjs CRDT (see
[06-yjs-projection](./yjs-projection.md)). It is rebuildable from CRDT state and never the
conflict resolver. This doc defines the entities, the hierarchy strategy, and the canonical
schema. The **authoritative DDL lives in [`/migrations`](../migrations/)** —
[`0001_init_v1.sql`](../migrations/0001_init_v1.sql) is the V1 schema of record. This doc is
decided commentary on that schema and MUST stay in sync with it; the
[`../idea-research-report.md`](../idea-research-report.md) is exploratory history, not
authority.

## Entity hierarchy

```
Workspace  (tenant / account)
   └── Document  (a "file"; one synthetic root item each)
         └── Item  (bullet / node — the atomic unit)
               ├── children: Item[]           (adjacency via parent_id)
               ├── ordering: rank (fractional index)
               ├── tags, dates, links
               └── item_refs  → mirrored targets   (DAG edges, V2)
```

- **Workspace** — the tenant boundary. Everything scopes under it.
- **Document** — Dynalist's multi-doc and Workflowy's single-infinite-doc both map here.
  Each document has **exactly one synthetic root item** so every real bullet has a parent
  (simplifies recursion and zoom). Enforced by the partial unique index, not a CHECK.
- **Item** — a bullet with rich-text content, a parent, ordered siblings, and metadata.

## Hierarchy strategy — decided

**Adjacency list is the source of truth; closure table (or `ltree`) is an optional
read accelerator.** This hybrid is the decision. → [ADR-0003](./adr/0003-hierarchy-adjacency-plus-closure.md)

| Pattern | Role in Open-Outliner |
|---------|----------------------|
| **Adjacency list** (`parent_id`) | ✅ **Source of truth.** Best for local writes: nest/move/reorder touch one row. |
| **Closure table** | ➕ **V2 accelerator** for breadcrumbs, "load zoomed subtree", `is-A-under-B`, permission inheritance. |
| **`ltree` materialized path** | ➕ Alternative read cache; nice for path queries. Pick closure *or* ltree, not both. |
| **Nested sets** | ❌ **Rejected.** Write amplification is fatal under frequent structural edits. |

**V1 ships adjacency + recursive CTEs only.** Add closure when slow-query logs show
ancestor/descendant queries dominating, or when permission inheritance lands (V2).

## Ordering — fractional indexing

Sibling order is a lexicographically-sorted `rank TEXT` column, **not** an integer
position. Inserting between two siblings updates only the moved item's rank — no
neighbor renumbering, which is exactly what offline clients and CRDT merges need. The full
algorithm, collision handling, and the mandatory `COLLATE "C"` requirement are in
[05-fractional-indexing](./fractional-indexing.md).

## Canonical schema (summary)

The full DDL is [`/migrations/0001_init_v1.sql`](../migrations/0001_init_v1.sql). Key tables
and the decisions baked into them:

### `items` — the core table

The load-bearing decisions in this table:

- **`parent_id UUID REFERENCES items(id) ON DELETE RESTRICT`** — *not* `CASCADE`. A cascade
  would physically erase a subtree without writing tombstones and break offline
  convergence. All user deletes are soft. → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)
- **`rank TEXT` with `COLLATE "C"`** — fractional index; byte-wise ordering is required.
- **`deleted_at TIMESTAMPTZ`** — soft-delete tombstone for sync/undo.
- **`version BIGINT`** — optimistic concurrency for the API/projection path.
- **One live root per document** enforced by:
  ```sql
  CREATE UNIQUE INDEX items_one_root_per_doc_idx
    ON items (document_id)
    WHERE parent_id IS NULL AND deleted_at IS NULL;
  ```
  This **replaces** the naive `CHECK (parent_id IS NOT NULL OR id IS NOT NULL)` from an
  earlier draft, which was always true (a PK is never NULL) and enforced nothing.

### `item_closure` — optional (V2)

Ancestor/descendant pairs with `depth`; self-row at depth 0. Maintained on write (trigger
or service) — the expensive case is subtree move (detach old ancestor links, reattach under
new parent's ancestors; batch carefully). Skip in V1 for small documents.

### `item_refs` — mirrors / multi-parent DAG (V2)

Presentation-layer edges letting one item appear under multiple parents (transclusion).
Decisions:

- `UNIQUE (parent_id, target_item_id)` — an item is mirrored under a given parent **at most
  once** (two identical mirror slots are noise). Drop only if you deliberately want
  duplicate transclusion instances.
- Its FK to `items` is `ON DELETE CASCADE` (unlike `items.parent_id`) because a ref is
  **pure presentation state** and not part of the CRDT tree — when the target is GC'd, the
  dangling ref should go with it; no tombstone needed.

### Supporting tables

- **`workspaces`**, **`documents`** — tenancy and file structure. `documents.root_item_id`
  FK is added after `items` exists.
- **Tags / dates / views** — see report §"Tags, Dates, and Views". Views (board/table) are V2.
- **`attachments`** — blob-plane metadata → [09-attachments](./attachments.md).
- **`yjs_updates`** — durable raw CRDT state (owned by Hocuspocus) → [06-yjs-projection](./yjs-projection.md).
- **`search_tsv`** — full-text (V2) → [08-search](./search.md).

## Indexing principles

1. **Document-scoped everything** — every hot index leads with `document_id`.
2. **Partial indexes on `deleted_at IS NULL`** keep the live working set small.
3. Children-in-order is the hottest path: `items (document_id, parent_id, rank) WHERE deleted_at IS NULL`.
4. Partition `items` by `document_id` hash **only after measuring** the need.

## Invariants the model must always hold

- No cycles in `parent_id` (enforced at CRDT merge and re-checked when projecting).
- Exactly one live root per document.
- `rank` uniqueness is **not** assumed — total order is `(rank, id)`; ties are legal and
  broken deterministically. → [05-fractional-indexing](./fractional-indexing.md)
- Structure changes only via the CRDT→projection path, never by direct SQL writes.
