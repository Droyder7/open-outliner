# ADR-0012 — Convergent cycle resolution

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

`parentId` is an LWW register (ADR-0008) resolved by the HLC (ADR-0009), and a move is now one
atomic register (ADR-0010). Each of those makes a *single* item's parent converge. But a tree
has a global invariant no per-item register can protect: **no cycles.**

Two replicas can each make a locally-valid move that only forms a cycle *in combination*:

- Replica A moves `X` under `Y`.
- Replica B concurrently moves `Y` under `X`.

Both moves win their own `parentId` LWW (they touch different items), both carry sane HLCs,
and neither replica saw the other. After merge every replica holds `X.parent = Y` **and**
`Y.parent = X` — a converged, agreed-upon **cycle**. The subtree `{X, Y}` is now detached
from the root and unreachable.

The current docs say cycles are "rejected/normalized at merge" and "re-checked when
projecting," and the projector "rejects" a cyclic projection. That is not an algorithm. It
never specifies:

1. **Which edge loses** — break `X→Y` or `Y→X`?
2. **Where the freed item goes** — it must land *somewhere* valid, not nowhere.
3. **Who emits the repair** — and how every replica performs the *same* repair without a
   coordinator, given the CRDT has no central authority.

Worse, "the projector rejects it" is a dead end: rejecting a SQL write does **not** change the
authoritative Yjs state, so the next projection pass re-derives the same cycle forever. This is
Critical finding #2.

## Decision

**Cycles are repaired by a deterministic, replica-local rule that every replica computes
identically from the merged CRDT state, and the repair is emitted as an ordinary HLC-stamped
`move` write (ADR-0010) — not a projector veto.**

### The rule — break the youngest edge on the cycle

When, after a merge, an item's ancestor walk revisits a node (a cycle is detected):

1. **Identify the cycle** — the set of items whose `move.parentId` edges form the loop.
2. **Break the edge with the greatest `move.hlc`** — the **youngest** move on the cycle is the
   one reverted. Because `move.hlc` is a total order (ADR-0009), every replica independently
   selects the *same* edge. "Youngest loses" means the move that *closed* the loop is the one
   undone, which matches user intuition: the earlier reorganization stands, the later one that
   completed the cycle is the one that didn't take.
3. **Reparent the freed item to a deterministic safe target** — the freed item is moved to the
   **document synthetic root** (null-sentinel parent), with a fresh `rank` at the end of the
   root's children and a **new `move.hlc` strictly greater than any HLC on the broken cycle**.
   Root is always a safe, always-existing, always-acyclic destination; landing there (rather
   than the item's *prior* parent, which may itself have moved or been deleted) needs no
   per-item history and can never re-form the same cycle.

### Who emits it, and why it converges

- **Any replica that observes the cycle emits the repair `move`.** The repair is a pure
  function of the merged state (`cycle set → youngest edge → root + end-rank + new HLC`), so
  two replicas that both detect it compute the **byte-identical target parent and a strictly
  dominant HLC**. `rank` uses the normal end-append generator seeded deterministically from the
  freed item's `id` (not wall-clock), so independent emissions agree; if two repairs still race
  on `rank`, `(rank, id)` ordering and LWW settle it exactly as any concurrent move.
- The repair is a **normal structural write** — it flows through the same `move` register,
  merges by the same HLC rule, and projects like any other move. There is no special
  "repair op," no coordinator, and no projector veto.
- **Idempotent:** once the freed item's parent is root and no cycle remains, the ancestor walk
  finds no loop and no further repair is emitted. Re-running detection on already-repaired state
  is a no-op.

### The projector's role — detect, never resolve

The materializer still runs an ancestor check (recursive CTE / closure) when projecting, but
its job on finding a cycle is **not to reject** — it is to confirm the CRDT layer has not yet
emitted the repair, and (if the server is a participating replica) emit it. A projected write
that would violate the tree invariant means "the repair `move` has not merged here yet," which
resolves on the next update — it is **not** a projector bug to fix by loosening a constraint.
This corrects the "projector rejects the cycle" language, which could never terminate.

### Surfacing

A repaired move is surfaced like any lost move (ADR-0008 / api-and-write-path "surface the
outcome"): the freed item shows a small "moved to top level to resolve a conflict" note in
activity history, so it never silently appears at root.

## Consequences

- **Correct / convergent:** cycles resolve to the same acyclic tree on every replica with no
  coordinator; the freed subtree is never lost (it is reachable under root); the projector can
  never loop on an unrepairable cycle.
- **Newly required:** cycle detection runs on merge (client) and on projection (server); the
  deterministic `rank` seed and "new HLC dominates the whole cycle" rules must be implemented
  exactly, or two replicas could pick different targets. A test must assert the classic
  `A↔B swap` converges identically on independent replicas.
- **Accepted trade-off:** "youngest edge loses + land at root" is simple and always-safe but
  not always the *prettiest* outcome — a repaired item goes to top level rather than back to
  some prior parent. Chosen deliberately: reconstructing a "previous good parent" requires
  per-item move history the CRDT does not keep, and any such heuristic risks re-forming the
  cycle. Root is the one destination that is provably safe and history-free.
- **Corrects** `sync-and-conflict-resolution.md` (§move semantics point 3, "normalized or
  dropped") and `yjs-projection.md` ("projector rejects / that's a projector bug") to this
  algorithm. Builds on ADR-0009 (total order) and ADR-0010 (atomic move).

## Alternatives considered

- **Reject the losing move at the projector (status quo wording):** cannot change
  authoritative Yjs state, so the cycle re-derives every pass — non-terminating. Rejected.
- **Break the *oldest* edge:** also deterministic, but reverts the earlier, likely
  already-observed reorganization and tends to surprise users more than undoing the move that
  just closed the loop. Rejected in favor of youngest-loses.
- **Reparent the freed item to its previous parent:** needs per-item parent history the CRDT
  doesn't retain, and the previous parent may itself be on the cycle or deleted — can re-form
  the loop. Rejected for the history-free root target.
- **Mirror-on-conflict (item lives under both parents):** that is the V2 multi-parent DAG mode
  (ADR-0007 / sync doc), a deliberate product feature, not a cycle *repair*. In strict-tree V1
  a cycle must be broken, not embraced.

## Cross-references

- [ADR-0008](./0008-yjs-document-schema.md) · [ADR-0009](./0009-move-clock-hlc.md) — LWW parent + HLC total order.
- [ADR-0010](./0010-atomic-move-register.md) — the `move` register the repair reuses.
- [ADR-0004](./0004-crdt-decides-postgres-records.md) — why the projector detects but never resolves.
- [sync-and-conflict-resolution.md](../sync-and-conflict-resolution.md) — merge narrative, corrected to this rule.
