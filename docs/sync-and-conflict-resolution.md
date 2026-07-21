# 04 — Sync & Conflict Resolution

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

How concurrent, offline, multi-device edits converge without a lock and without a human
resolving merges. The deep survey is in the report §"Conflict resolution strategies for
concurrent tree moves"; this doc records the decisions.

## Decision summary

| Question | Decision |
|----------|----------|
| Conflict model | **CRDT** (Yjs), not OT | → [ADR-0002](./adr/0002-sync-engine-yjs-vs-localfirst.md) |
| Structure representation | Per-item `parentId` + `rank` **LWW registers** in a `Y.Map`; rich text in `Y.Text` | → [ADR-0008](./adr/0008-yjs-document-schema.md), [yjs-schema.md](./yjs-schema.md) |
| Concurrent move semantics | **Last-writer-wins on `parentId`**; sibling order is an **LWW fractional `rank` register**, read `(rank, id)` | → [ADR-0008](./adr/0008-yjs-document-schema.md) |
| Tie-break | Hybrid Logical Clock `{ wallMs, counter, replicaId }`, compared in that order | → [ADR-0009](./adr/0009-move-clock-hlc.md) |
| Cycle handling | Reject/normalize at merge; re-check when projecting |
| Delete semantics | **Soft delete / tombstone**; GC hard-deletes later | → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md) |
| Where Postgres sits | Downstream **projection**, never a resolver | → [ADR-0004](./adr/0004-crdt-decides-postgres-records.md) |

## Why CRDT, not OT

OT needs a central authority to transform operations and gets genuinely hard for **tree
moves** (transforming concurrent moves against each other is where OT implementations
break). CRDTs converge without a central resolver, handle offline edits and network
partitions natively, and Yjs is the proven, standard choice for collaborative editors. The
report surveys server-authoritative OT (Strategy 1) and finds it workable only with a
central DB and simpler needs — which is not our offline-first bar.

## The move problem, and our semantics

Concurrent tree moves are the hard case. Two replicas can move the same item to different
parents, or move items in ways that would create a cycle (A under B while B moves under A).
Our decided semantics, per the report's recommended approach:

1. **`parentId` is an LWW register per item.** Concurrent moves to different parents converge
   to one winner deterministically via the **Hybrid Logical Clock** (`wallMs`, then `counter`,
   then `replicaId`). The loser's move is dropped — not corrupted. → [ADR-0009](./adr/0009-move-clock-hlc.md)
2. **Sibling order is an LWW fractional `rank` register**, sorted `(rank, id)` at read
   (ADR-0008). There is **no** `Y.Array` of child order in V1; inserting/moving between two
   siblings sets only the moved item's `rank`. The known interleaving trade-off is accepted and
   upgradeable to a list-CRDT in V2 without reshaping the relational model.
   → [05-fractional-indexing](./fractional-indexing.md)
3. **Cycles are rejected at merge.** Ancestor checks (closure table / CTE when projecting)
   catch a move that would make the tree non-tree. The move is normalized or dropped, never
   applied to produce a cycle.
4. **Surface the outcome.** If a user's move lost to concurrency, show it in activity
   history / a small conflict note so it doesn't feel arbitrary.

### Optional: mirror-on-conflict (V2)

Instead of dropping the losing move, "mirror mode" can create an `item_refs` mirror under
the other parent — the item then lives in both places (DAG). This is a V2 differentiator:
**LWW-parent in strict-tree mode, mirror-on-conflict in multi-parent mode**, both on top of
the same CRDT engine. → [03-data-model](./data-model.md) `item_refs`

## The reconciling invariant (why this is safe)

The report contains two framings that look contradictory — "Postgres is a projection of
CRDT state" vs. a schema full of constraints and (optional) triggers. They coexist because
they live at different layers:

- **The CRDT layer is the only conflict resolver.** All LWW-parent / LWW-rank / cycle
  resolution happens **before** anything touches Postgres.
- **Postgres constraints/triggers are integrity guards on an already-resolved write** —
  never a second resolver. If a projected write would violate a constraint, that is a
  **projector bug to fix**, not a conflict to arbitrate in SQL.
- **No cascades, no DB-side structural mutation.** The DB is downstream of merge, so
  `parent_id` is `RESTRICT` and physical deletes live only in the tombstone-aware GC. The
  race "cascade delete vs concurrent LWW move-in" **cannot occur** if the DB never cascades
  and merge already ordered the two ops.

> **CRDT decides, Postgres records and validates.** → [ADR-0004](./adr/0004-crdt-decides-postgres-records.md)

## Delete & convergence

Deletes are soft so an offline replica that never saw the delete converges instead of
resurrecting rows:

1. **User delete** → set `deleted_at` on the subtree root (mark descendants via closure/CTE,
   or treat descendants as implicitly deleted at read time). Emit a tombstone so peers
   converge.
2. **GC (background, tombstone-aware)** → after a retention window long enough that all
   known replicas have synced past the tombstone, hard-delete bottom-up (leaves first) under
   a document advisory lock. **Only GC issues physical `DELETE`.**

A raw `DELETE` on `items` MUST NOT be exposed to the app/API layer — it would race a
concurrent LWW move-in. → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)

## Serialization

Hierarchy mutations are **serialized per document** (advisory lock on
`hashtext(document_id)`) so two server workers can't interleave rank/closure writes for the
same document under multiplayer + offline replay. → [06-yjs-projection](./yjs-projection.md)

## What this buys us

- Edits always succeed locally (offline-first principle #1).
- Concurrent edits converge deterministically with no lock and no lost structure.
- The queryable model is always derivable/rebuildable from the CRDT, so a projector bug is
  recoverable, not data loss.
