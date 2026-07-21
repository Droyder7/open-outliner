# ADR-0006 — Soft delete + tombstone-aware GC (no cascade)

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

The system is offline-first: a replica may be disconnected when an item is deleted elsewhere.
The schema leans on `deleted_at` tombstones so replicas converge. But an early draft also had
`items.parent_id ... ON DELETE CASCADE`. A physical `CASCADE` erases a subtree **without
writing tombstones**, so an offline replica that never saw the delete would resurrect the
rows on next sync — or diverge permanently. Cascades also race concurrent LWW move-ins (an
item being moved *into* a subtree that is being physically deleted).

## Decision

**All user-facing deletes are soft (set `deleted_at`).** `items.parent_id` is
**`ON DELETE RESTRICT`, not `CASCADE`.** Physical deletion is confined to a single
**tombstone-aware GC job.** No raw `DELETE` on `items` is exposed to the app/API layer.

The delete path:

1. **User delete** → set `deleted_at` on the subtree root (mark descendants via closure/CTE,
   or treat them as implicitly deleted at read time). Emit a tombstone so peers converge.
2. **GC (background, tombstone-aware)** → after a retention window long enough that all known
   replicas have synced past the tombstone, hard-delete **bottom-up** (leaves first) under a
   document advisory lock. Only GC issues physical `DELETE`.

## Consequences

- **Easier / correct:** offline replicas converge instead of resurrecting rows; undo is
  trivial (clear `deleted_at`); the cascade-vs-move-in race cannot occur because the DB never
  cascades.
- **Newly required:** a GC worker with a correct retention window (a **correctness** property,
  not just cleanup — too short and an offline replica re-adds a reference to a physically
  gone row); descendant tombstoning strategy (eager mark vs lazy read-time filter) must be
  chosen.
- Consistent with ADR-0004: the DB takes **no autonomous structural action**; deletes are
  tombstones the projector writes, physical removal is a separate, deliberate job.
- **`item_refs` is the deliberate exception:** its FK is `ON DELETE CASCADE` because a ref is
  pure presentation state, not part of the CRDT tree (see ADR-0007 / data-model).

## Alternatives considered

- **`ON DELETE CASCADE` on `parent_id`:** simplest to write, but breaks offline convergence
  and races moves. Rejected.
- **Immediate hard delete + rely on CRDT tombstones only:** the CRDT can carry the delete,
  but the relational projection would lose the subtree before all replicas converge, and
  API/search consumers would see inconsistent intermediate states. The soft-delete + GC split
  keeps the projection correct throughout.
