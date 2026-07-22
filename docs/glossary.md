# 13 — Glossary

**Status:** Accepted · **Last updated:** 2026-07-21

Terms used consistently across all docs. When a doc uses one of these, it means exactly this.

| Term | Definition |
|------|------------|
| **Workspace** | The tenant / account boundary. Everything scopes under it. |
| **Document** | A "file" within a workspace; has exactly one synthetic root item. Workflowy's single doc and Dynalist's multi-doc both map here. |
| **Item** | The atomic unit: a bullet with text content (plain text in V1 — [ADR-0018](./adr/0018-plain-text-content-v1.md)), a parent, ordered siblings, tags, and metadata. |
| **Synthetic root** | The single `parent_id IS NULL` item per document, so every real bullet has a parent. Enforced by a partial unique index. |
| **Adjacency list** | Hierarchy stored as each item pointing to its `parent_id`. **The source of truth** for structure. |
| **Closure table** | Precomputed ancestor↔descendant pairs (`item_closure`). An optional **read accelerator** (V2), not the source of truth. |
| **`ltree` / materialized path** | Postgres path-string alternative to a closure table as a read cache. Choose closure *or* ltree, not both. |
| **Nested sets** | A left/right-bound hierarchy model. **Rejected** — write amplification is fatal under frequent edits. |
| **Fractional index / `rank`** | A `TEXT` order key that sorts lexicographically between neighbors, so inserts touch one row. → [05](./fractional-indexing.md) |
| **`COLLATE "C"`** | Byte-wise collation on `rank`. **Required** — locale collations break fractional-index ordering. |
| **`(rank, id)` total order** | Ordering is by `rank` then `id`. `rank` is **not** unique; ties are legal and broken by `id`. |
| **openSpace** | Rank-generation strategy that opens room when inserting between collided ranks. |
| **Jitter** | Small randomization at rank generation to lower concurrent-collision rate between offline clients. |
| **Rebalance** | Rare escape-hatch pass that reassigns ranks when keys grow pathologically long; broadcast as LWW rank updates. |
| **CRDT** | Conflict-free Replicated Data Type. Converges concurrent edits with no central resolver. We use **Yjs**. |
| **Yjs** | The chosen CRDT engine. The **source of truth** for outline structure and text content. |
| **Hocuspocus** | The Yjs-compatible WebSocket server; hosts the materializer hook. |
| **LWW register** | Last-Writer-Wins value keyed by `(timestamp, replicaId)`. Used for the `parent` and `rank` fields. |
| **Materializer** | Server-side component (Hocuspocus `onChange` hook) that projects merged Yjs state into Postgres rows. → [06](./yjs-projection.md) |
| **Projection** | The relational (`items`, etc.) representation derived from the CRDT. Queryable, rebuildable, **downstream** — never a conflict resolver. |
| **Three data planes** | CRDT plane (structure/text), projection plane (queryable rows), blob plane (attachments). → [01](./architecture-overview.md) |
| **Soft delete / tombstone** | Marking `deleted_at` instead of physically deleting, so offline replicas converge. |
| **Tombstone-aware GC** | The **only** component that issues physical `DELETE`, bottom-up, after a retention window. → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md) |
| **Mirror / transclusion** | An item appearing under multiple parents via `item_refs` (a DAG edge). Presentation state, not part of the CRDT tree. V2. |
| **Blob plane** | The attachment sync path: IndexedDB outbox → S3, referenced by items. Binaries never enter the Yjs doc. → [09](./attachments.md) |
| **Outbox / mutation queue** | Durable local queue of pending API writes / uploads, replayed via Background Sync on reconnect. |
| **PWA** | Progressive Web App — the primary client surface (installable, offline-capable). |
| **Presigned URL** | Time-limited S3 PUT/GET URL signed by the server so credentials never reach the client. |
