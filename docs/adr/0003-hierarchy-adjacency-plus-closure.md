# ADR-0003 — Adjacency list as truth, closure/ltree as accelerator

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

The core relational question is how to store an infinitely-nestable tree that is edited
frequently (nest, move, reorder) and read in specific hot patterns (children-in-order,
breadcrumbs, zoomed subtree, "is A under B"). The report compared adjacency list, closure
table, materialized path/`ltree`, and nested sets.

## Decision

**Adjacency list (`parent_id`) is the source of truth.** A **closure table** (or maintained
`ltree` path) is an **optional read accelerator added in V2** when read patterns demand it.
**Nested sets are rejected.** Pick closure *or* ltree — not both.

## Consequences

- **Easier:** structural writes (the common case — nest/move/reorder) touch a single row;
  this is exactly what offline clients and CRDT merges want.
- **V1 simplicity:** ship adjacency + recursive CTEs only; no closure maintenance to get
  right initially.
- **Newly required in V2:** closure maintenance on write — the expensive case is subtree
  move (detach old ancestor links, reattach under the new parent's ancestors; batch
  carefully). Add it only when slow-query logs justify it, or when permission inheritance
  (which rides the closure table) lands.
- Closure/ltree can be **back-filled anytime** from the rebuildable projection, so deferring
  is safe.

## Alternatives considered

- **Nested sets (left/right):** excellent for read-only ancestor/descendant queries but
  **write amplification is fatal** under frequent structural edits — every insert/move
  renumbers a large range. Rejected outright for this product class.
- **Closure-only from day one:** more upfront machinery than V1 needs when documents are
  small (recursive CTEs suffice under a few thousand nodes).
- **Both closure and ltree:** redundant; two things to keep in sync for one benefit.
