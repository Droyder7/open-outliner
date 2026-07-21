# 12 — Roadmap (V1 / V2)

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

The discipline here is **ship the outliner before the platform**. V1 is "a delightful,
reliable, collaborative outliner." Everything that isn't that is V2 — but the V1 schema is
designed so V2 doesn't require a reshape. Mirrors report §"Recommended V1 vs V2".

## V1 — ship the outliner

**Data model**
- `workspaces` → `documents` → `items` with `parent_id` + fractional `rank`.
- Soft delete, `version`, tags, basic links.
- Recursive CTEs for breadcrumbs and limited-depth trees.
- **No closure table yet.**

**Sync & client**
- Yjs doc as client source of truth; `y-indexeddb` local persistence.
- Hocuspocus realtime + materializer projection to Postgres.
- Offline editing with Background-Sync mutation queue.
- LWW-parent + CRDT list order; soft-delete convergence.

**Features**
- Infinite nesting, zoom, keyboard/drag reorder + re-parent.
- Rich-text items (TipTap), multi-document workspace, presence.
- Tags, basic links, soft delete + undo, export.
- Offline image capture with deferred upload (basic).

**The V1 bar:** work offline for a day and sync cleanly; two users concurrent-edit without
corruption; 10k-item outlines stay responsive; self-host from `docker compose` + Postgres + S3.

## V2 — scale + Workflowy parity

- **`item_closure`** (or maintained `ltree path`) as a read accelerator.
- **`item_refs`** — mirrors / multi-parent DAG; mirror-on-conflict mode.
- **`views`** — board / table views over items.
- **Permission inheritance** down the tree via closure.
- **Server-side full-text search** (`tsvector` + GIN) alongside client offline search.
- Optional **rank rebalance worker**.
- Optional stronger ordering via a full **list-CRDT** (removes the interleaving wart).

## Explicitly deferred / reassess-later (not V2-committed)

- Native mobile shells (Capacitor/Expo) — only if PWA limits bite.
- Local-first sync engine (Replicache/ElectricSQL/PowerSync/Jazz) instead of hand-rolled Yjs
  persistence — revisit if Yjs persistence/permissions cost outgrows benefit.
  → [ADR-0002](./adr/0002-sync-engine-yjs-vs-localfirst.md)
- External search engine (Elasticsearch/Meilisearch/etc.) — only if Postgres FTS is outgrown.
- Semantic/vector search.
- Table partitioning of `items` — only after measuring need.

## Design-for-V2-now checklist (things V1 must not preclude)

These exist in the V1 schema/architecture precisely so V2 is additive:

- [x] `rank` is fractional + `COLLATE "C"` → ordering scales without reshape.
- [x] `parent_id` is `RESTRICT` + soft delete → GC and convergence already correct.
- [x] Projection is rebuildable from Yjs → closure/FTS can be back-filled anytime.
- [x] `item_refs` / `views` / `search_tsv` shapes are specified though unshipped.
- [x] Everything is document-scoped → partitioning and permission inheritance drop in cleanly.
