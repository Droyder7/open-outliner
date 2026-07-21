# ADR-0005 — Fractional indexing for sibling order

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

Siblings need a stable, mergeable order that survives offline edits and CRDT merges.
Integer positions force renumbering on insert-between; float midpoints run out of precision;
a `UNIQUE(parent_id, rank)` constraint turns benign concurrent collisions into hard errors.

## Decision

Use **string fractional indexing** on a `rank TEXT COLLATE "C"` column, with this specific,
production-proven combination:

- **Jitter** at generation time to lower concurrent-collision rate.
- **Total order is `(rank, id)`** — `rank` is **not** unique; ties are legal, broken by `id`.
- **`COLLATE "C"`** for byte-wise ordering (mandatory).
- **`openSpace`** when inserting between collided ranks.
- **LWW on the `rank` field** for concurrent-move merges.
- **No `UNIQUE(parent_id, rank)` constraint.**

## Consequences

- **Easier:** inserting/moving between two siblings updates only the moved item's rank — no
  neighbor renumbering, ideal for offline + CRDT merge.
- **Newly required / rules:** the `rank` column MUST be `COLLATE "C"` or client and server
  order silently diverge; ordering queries MUST use `(rank, id)`, never `rank` alone; the
  projector must tolerate benign collisions rather than reject them.
- **Known wart:** concurrent interleaved inserts can read as interleaved rather than grouped
  — accepted for V1; a full list-CRDT (V2) removes it at the cost of weight.
- **Escape hatch:** a rebalance worker (V2) reassigns pathologically long keys and
  broadcasts them as LWW rank updates; offline clients with stale ranks lose the LWW —
  acceptable because rebalance is rare.

## Alternatives considered

- **Integer `position`:** renumbers all following siblings on insert-between — terrible for
  concurrent/offline clients.
- **Float midpoints (Figma's first idea):** exhausts float precision after ~50 midpoints
  between the same neighbors.
- **`UNIQUE(parent_id, rank)`:** converts a harmless concurrent collision into a DB error and
  fights LWW merges. Explicitly avoided.
- **Full list-CRDT for order in V1:** cleanest non-interleaving guarantee but heavier than V1
  needs; deferred to V2.
