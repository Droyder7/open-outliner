# ADR-0008 — Yjs document schema & order model

**Status:** Accepted (schema shape refined by [ADR-0010](./0010-atomic-move-register.md); delete
register added by [ADR-0011](./0011-crdt-tombstone.md)) · **Date:** 2026-07-22 · **Deciders:** _TBD_

> **Note (2026-07-22):** the flat `parentId` / `rank` / `move` layout below is superseded by
> [ADR-0010](./0010-atomic-move-register.md), which folds `parentId` + `rank` + `hlc` into one
> atomic `move` register to prevent torn moves, and by [ADR-0011](./0011-crdt-tombstone.md),
> which adds an explicit `deleted` register. The order-model decision (LWW rank, no `Y.Array`)
> is unchanged. The living, corrected shape is in [yjs-schema.md](../yjs-schema.md).

## Context

The Yjs document is the source of truth for structure and text (ADR-0004). Every other
subsystem — the editor binding, the materializer diff, the move-conflict semantics — depends
on its exact shape. Two blockers had to be resolved before any code could be written:

1. **The order model contradicted itself across docs.** `fractional-indexing.md` described
   sibling order as an **LWW `rank` register** sorted `(rank, id)` at read; the sync doc
   described it as a **CRDT list** over ranks. These are two different Yjs schemas.
2. **The item-node shape was never pinned** — which fields are LWW registers, which is the
   collaborative text type, where the move clock lives.

This ADR pins both.

## Decision

### Document shape

The authoritative Yjs document for a single Open-Outliner document is a top-level
`Y.Map` named `items`, keyed by item id, whose values are per-item `Y.Map`s:

```
ydoc.getMap("items") : Y.Map<itemId, Y.Map>

itemNode (Y.Map):
  parentId : string     — LWW; the move register (null-string sentinel for root)
  rank     : string     — LWW; fractional index (byte-wise / COLLATE "C" domain)
  type     : string     — LWW enum: 'bullet' | 'task' | 'heading' | 'divider'
  content  : Y.Text     — collaborative rich text, TipTap-bound
  move     : Y.Map      — HLC { wallMs, counter, replicaId } guarding parentId + rank (ADR-0009)
  isCompleted : boolean — LWW
  isCollapsed : boolean — LWW
```

- `parentId` and `rank` are **plain LWW values** in the item's `Y.Map` — Yjs `Y.Map` already
  provides last-writer-wins per key on concurrent sets. The **move clock** (`move`, ADR-0009)
  is what makes "last" deterministic across offline replicas and keeps a concurrent text edit
  from stomping a move.
- `content` is a `Y.Text` so rich-text editing merges character-by-character (the one place we
  want fine-grained CRDT text, not LWW).
- The **synthetic root** is the single item with the null-sentinel `parentId`; enforced in the
  relational projection by the partial unique index (`items_one_root_per_doc_idx`).

### Order model — LWW rank register (decided)

**Sibling order is the LWW fractional `rank` register. There is no `Y.Array` of child ids in
V1.** Read order is `(rank, id)`:

- Inserting/moving between two siblings sets only the moved item's `rank` (ADR-0005) — no
  neighbor writes, which is what makes offline + merge cheap.
- `rank` is **not** unique; ties are legal and broken deterministically by `id`.
- This is the report's own recommendation and is consistent with ADR-0005.

**Accepted trade-off — the interleaving wart.** Two users concurrently inserting runs of
siblings between the same bounds can produce an order that reads as interleaved rather than
grouped. This is a known, accepted limitation of bare fractional ranks for V1.

**V2 upgrade path is additive.** If interleaving becomes product-visible, introduce a
list-CRDT (e.g. `Y.Array` of child ids per parent, or a tree-CRDT) as the authoritative order
and demote `rank` to a projection cache. Because `rank` already exists as the SQL ordering
key, that change does not reshape the relational model — it only changes who is authoritative
for order. No migration of `items` is required.

### Supersedes

This ADR **supersedes the "Sibling order is a CRDT list" language** in
`sync-and-conflict-resolution.md`. That doc is corrected to point here.

## Consequences

- **Easier:** one unambiguous Yjs shape for the client editor binding and the materializer to
  implement against; move conflicts reduce to LWW-on-`parentId` with the HLC tie-break; the
  materializer diff target is a flat `Y.Map` of items, not a nested tree to walk.
- **Newly required:** the client must maintain the HLC on every structural write (ADR-0009);
  the materializer reads this flat map and projects each entry to an `items` row
  (`yjs-schema.md` gives the field→column map).
- **Accepted downside:** interleaving under concurrent sibling runs (see above).

## Alternatives considered

- **Full list-CRDT for order in V1** (`Y.Array` per parent / tree-CRDT authoritative): removes
  interleaving but adds a second authoritative structure to keep consistent with `parentId`,
  and is heavier than V1 needs. Deferred to V2 as an additive upgrade.
- **Nested Yjs tree** (child maps embedded under parents rather than a flat id-keyed map):
  makes moves expensive (re-parent = move a subtree in the CRDT) and complicates the diff.
  Rejected in favor of the flat adjacency map, mirroring the relational adjacency-list choice
  (ADR-0003).

## Cross-references

- [ADR-0004](./0004-crdt-decides-postgres-records.md) — CRDT decides, Postgres records.
- [ADR-0005](./0005-fractional-indexing-ordering.md) — fractional indexing.
- [ADR-0009](./0009-move-clock-hlc.md) — the HLC move clock.
- [yjs-schema.md](../yjs-schema.md) — the pinned, living schema + plane-ownership table.
