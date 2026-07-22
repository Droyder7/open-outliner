# 01 — Architecture Overview

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

The whole system on one page. Deeper docs branch from here.

## The load-bearing idea

> **CRDT decides. The materializer writes. Postgres records and validates.**

Structure and text live in a **Yjs CRDT document**. That is the source of truth. A
server-side **materializer** projects the merged CRDT state into a **PostgreSQL**
relational model that everything queryable (search, views, API, permissions) reads from.
Postgres never resolves a conflict and never mutates structure on its own — its
constraints and triggers are *integrity guards on an already-resolved write*, not a second
resolver. Hold this invariant and the rest of the design follows.

## Component map

```
┌─────────────────────────── CLIENT (React/Vite PWA) ───────────────────────────┐
│                                                                                │
│  UI (outliner components, direct Y.Text binding — ADR-0018)                    │
│      │  binds to                                                               │
│      ▼                                                                          │
│  Yjs document  ──────────►  y-indexeddb  ──►  IndexedDB (local persistence)    │
│      │                                            ▲                             │
│      │  ops                                       │  cached blobs               │
│      ▼                                            │                             │
│  Mutation / sync queue        Attachment outbox ──┘   Service worker (Workbox)  │
│      │  websocket                     │ presigned PUT/GET (online)              │
└──────┼────────────────────────────────┼───────────────────────────────────────┘
       │                                 │
       ▼                                 ▼
┌──────────────────────── SERVER (Node.js / TypeScript) ─────────────────────────┐
│                                                                                │
│  Hocuspocus (Yjs WebSocket server)                                             │
│      │  persists raw Yjs updates ─────────────►  yjs_updates (durable CRDT)     │
│      │                                                                          │
│      │  onChange (debounced)                                                    │
│      ▼                                                                          │
│  Materializer  ── diff Y.Map/Y.Array ──►  PostgreSQL                           │
│                                            • items (adjacency + rank)           │
│                                            • item_closure (optional, V2)        │
│                                            • tags / dates / views / attachments │
│                                            • search_tsv (V2)                    │
│      REST/RPC API  ◄── reads projection ──┘                                     │
│      Auth (sessions/JWT)      GC worker (tombstone-aware hard delete)           │
└──────────────────────────────────────┬─────────────────────────────────────────┘
                                        │
                                        ▼
                                  S3 (attachment blobs)
```

## The three data planes

Open-Outliner deliberately runs edits down **three different pipes**, because they have
different shapes and failure modes. Confusing them is the most common way to get this
architecture wrong.

| Plane | Carries | Path | Source of truth |
|-------|---------|------|-----------------|
| **CRDT plane** | Outline structure + text | Yjs ⇄ Hocuspocus, persisted as `yjs_updates` | **Yjs doc** |
| **Projection plane** | Queryable rows (search, views, API) | Materializer → Postgres | Derived (rebuildable) |
| **Blob plane** | Images / file attachments | IndexedDB outbox → S3, referenced by items | **S3 + `attachments` row** |

Text and structure go on the CRDT plane; megabyte binaries never enter the Yjs doc (that's
the blob plane); anything you need to `SELECT ... WHERE` lives on the projection plane and
is disposable/rebuildable from the CRDT. → [06-yjs-projection](./yjs-projection.md),
[09-attachments](./attachments.md)

## Read vs write flow

**Write (edit an item):**
1. UI mutates the Yjs doc → instantly reflected locally, persisted to IndexedDB.
2. Op is sent over WebSocket to Hocuspocus; if offline, it's queued and replayed on reconnect.
3. Hocuspocus merges, persists the raw update, and fires a debounced `onChange`.
4. Materializer diffs the merged state and upserts `items` rows (per-document advisory lock).

**Read (load a document / search / view):**
- Live outline structure and text render **from the local Yjs doc** — no server round-trip.
- Search, boards/tables, breadcrumbs across not-yet-loaded data, and API consumers read the
  **Postgres projection**.

## Key boundaries & invariants

- **No client writes SQL.** Clients speak Yjs (structure/text) and the REST/RPC API
  (queries, auth, attachments). Structure is never mutated by writing `items` directly —
  such a write would be overwritten by the next projection pass. → [10-api-and-write-path](./api-and-write-path.md)
- **Deletes are soft.** `deleted_at` tombstones so offline replicas converge; only the GC
  worker issues physical `DELETE`, bottom-up, after a retention window.
  → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)
- **`parent_id` is `ON DELETE RESTRICT`, never `CASCADE`.** A cascade would erase a subtree
  without tombstones and break convergence.
- **Everything is document-scoped.** All hot indexes lead with `document_id`; all tenancy
  checks scope by workspace first. → [11-security-and-multitenancy](./security-and-multitenancy.md)

## Where to go next

- The exact components and discarded alternatives → [02-tech-stack](./tech-stack.md)
- The schema and hierarchy model → [03-data-model](./data-model.md)
- How concurrency actually converges → [04-sync-and-conflict-resolution](./sync-and-conflict-resolution.md)
