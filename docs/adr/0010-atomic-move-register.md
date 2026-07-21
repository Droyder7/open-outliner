# ADR-0010 — The move is one atomic register (no torn moves)

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

ADR-0008 pinned the item node as a `Y.Map` with `parentId`, `rank`, and a separate `move`
HLC (ADR-0009). ADR-0009 says a structural write "is applied iff its `move` is strictly
greater." But those three are **independent keys in a `Y.Map`**, and `Y.Map` resolves each
key by its *own* last-writer-wins, independently of the others. Nothing in the pinned schema
makes the projector — or Yjs itself — treat `{parentId, rank, move}` as a single unit.

That gap allows a **torn move**. Two replicas move the same item concurrently:

- Replica A: `parentId = P_a`, `rank = r_a`, `move = m_a`
- Replica B: `parentId = P_b`, `rank = r_b`, `move = m_b`, with `m_b > m_a`

If the two writes are three separate `Y.Map.set` calls each, Yjs merges **per key**. It is
entirely possible for the map to converge to `parentId = P_b` (B wins that key) while
`rank = r_a` (A's rank write happened to be the later Yjs operation on *that* key). Every
replica still converges to the *same* torn state — so this is not a divergence bug, it is
worse: a **silently wrong but agreed-upon** placement that no replica flags. The item lands
under B's new parent at A's old-sibling rank. The `move` HLC was supposed to prevent exactly
this, but only guards "text vs move," never "the move's own fields against each other."

This is the residual half of the original Critical finding #1: the HLC fixed *which* clock
decides and stopped text from stomping a move, but never made the move **atomic**.

## Decision

**A move is one register. `parentId` and `rank` are carried as fields of the `move` value,
not as sibling keys, and the projector accepts them only as an all-or-nothing unit gated by
that value's HLC.**

### Schema change — fold the structural fields into `move`

The item node's authoritative structural state is a single `Y.Map` key, `move`, whose value
is a nested `Y.Map`:

```
itemNode (Y.Map):
  move : Y.Map        — the atomic structural register
    parentId : string   — null-sentinel for the synthetic root
    rank     : string   — fractional index (COLLATE "C" domain)
    hlc      : Y.Map     — { wallMs, counter, replicaId } (ADR-0009)
  type        : string   — LWW (unchanged)
  content     : Y.Text   — collaborative rich text (unchanged)
  deleted     : Y.Map    — LWW tombstone register (ADR-0011)
  isCompleted : boolean  — LWW (unchanged)
  isCollapsed : boolean  — LWW (unchanged)
  note        : Y.Text?  — optional (unchanged)
```

- `parentId`, `rank`, and `hlc` are **never written independently**. A structural mutation
  (insert-between, reorder, re-parent) replaces the *whole* `move` value in one Yjs
  transaction: compute the new `hlc`, the new `parentId`, and the new `rank`, then set them
  together.
- The write is **conditional**: a replica applies an incoming `move` iff its `hlc` is
  strictly greater than the currently-stored `move.hlc` by the ADR-0009 comparison. Because
  the three fields travel together and are gated by one clock, the winner's `parentId` and
  `rank` are always the winner's — a torn `{P_b, r_a}` state is **unrepresentable**.

### Why a nested value and not a discipline note

We considered simply *documenting* "always set the three keys in one transaction." Rejected:
a Yjs transaction makes the three `set`s **atomic against observers**, but it does **not**
make merge treat them as a unit — each key still merges independently across replicas, so the
torn-move race survives a transaction. The atomicity has to live in the **data shape** (one
value the HLC guards), not in write discipline. This is the same reasoning ADR-0008 used to
reject "keep order consistent by convention."

### Projector contract

The materializer reads `move.parentId` and `move.rank` as a pair. It MUST NOT project a
`parent_id` from one observed state and a `rank` from another. The winning `move.hlc` is what
it records as the row's `version` provenance (ADR-0009 `move → version`).

## Consequences

- **Correct:** the exact "which parent, which rank" pairing the user intended is preserved;
  concurrent moves resolve to *one whole* winning placement; the projector has a single value
  to diff instead of three keys to correlate.
- **Newly required:** the client editor binding MUST perform every structural change as a
  single `move`-value replacement inside one Yjs transaction (never a bare `set('rank', …)`).
  Reorder-only (same parent, new rank) still rewrites the whole `move` with a fresh `hlc`.
- **Supersedes** the flat `parentId` / `rank` / `move` key layout in ADR-0008 and
  `yjs-schema.md`; both are corrected to the nested `move` shape. ADR-0009's clock and
  comparison are unchanged — only *what the clock guards* is tightened from "two sibling keys"
  to "one nested value."
- **Migration impact:** none on the relational side. `items.parent_id` and `items.rank` stay
  as they are; only the CRDT-plane shape and the projector's read change.

## Alternatives considered

- **Transaction-only discipline (no shape change):** insufficient — Yjs merges per key across
  replicas regardless of transaction grouping. Rejected above.
- **A monotonic single string encoding `parent|rank|hlc` in one LWW key:** works, but makes
  the value opaque to the editor binding and to debugging, and forces string parsing in the
  projector. The nested `Y.Map` keeps the fields legible while still being HLC-gated as a unit.
- **A dedicated move-log CRDT (append-only ops):** heavier than V1 needs and duplicates what
  the HLC-gated register already gives us. Deferred; not required for correctness here.

## Cross-references

- [ADR-0008](./0008-yjs-document-schema.md) — the document schema this tightens.
- [ADR-0009](./0009-move-clock-hlc.md) — the HLC that now guards the whole `move` value.
- [ADR-0011](./0011-crdt-tombstone.md) — `deleted` is the sibling LWW register for delete.
- [ADR-0012](./0012-convergent-cycle-resolution.md) — how a *valid* winning move that still
  forms a cycle is repaired.
- [yjs-schema.md](../yjs-schema.md) — the living schema, corrected to this shape.
