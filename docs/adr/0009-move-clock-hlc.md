# ADR-0009 — Move/rank clock: Hybrid Logical Clock (HLC)

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

> **Note (2026-08-16):** the replica id's SCOPE is refined by
> [ADR-0019](./0019-replica-ack-gc-gating.md) — it is minted once per **tab**
> (`sessionStorage`), not once per install, because it is also the key of the
> `replica_sync` ack ledger and each tab is an independent editing replica. The
> clock's structure, comparison, and update rules below are unchanged.

> **Note (2026-07-22):** this ADR describes the HLC as guarding `parentId` + `rank` as two
> sibling keys. [ADR-0010](./0010-atomic-move-register.md) tightens *what* the clock guards —
> the HLC now lives inside a single atomic `move` register alongside `parentId` and `rank`,
> written as one unit — but the clock's structure, comparison, and update rules below are
> unchanged.

## Context

Order and parent are **LWW registers** (ADR-0008): on a concurrent write, the item keeps the
value from the "last" writer. But "last" is undefined without a clock, and in an offline-first,
multi-device system we cannot trust wall-clock time:

- A device with a **skewed or backwards clock** would otherwise win or lose moves arbitrarily.
- A bare **wall-clock timestamp** has no deterministic tie-break, so two replicas can disagree
  on the winner and **diverge** — fatal for a CRDT projection.
- A pure **Lamport clock** is deterministic but discards real time entirely, so a stale offline
  edit made "later" by counter can beat a fresh edit made "earlier," which reads as surprising
  to users (an old move resurrecting).

We need a "last" that is **deterministic across replicas** (so everyone picks the same winner)
and **respects real time when clocks are roughly sane** (so recent intent usually wins).

## Decision

`parentId` and `rank` share **one Hybrid Logical Clock register per item**, named `move`.
A single HLC guards both fields together so that a concurrent **text edit never stomps a move**
and a **move never stomps text** — text lives in `content` (`Y.Text`, ADR-0008) and is merged
independently; only structural fields are gated by `move`.

### Structure

```
move: { wallMs: number, counter: number, replicaId: string }
```

### Comparison (defines "last" — later wins)

Compare lexicographically in this fixed order:

1. `wallMs`   — higher wins
2. `counter`  — higher wins (breaks equal-millisecond ties)
3. `replicaId` — higher wins (final deterministic tie-break; arbitrary but total)

Because `replicaId` is unique per replica, the comparison is a **total order** — every replica
independently computes the same winner for any two `move` stamps. A structural write is applied
iff its `move` is strictly greater than the currently-stored `move`.

### Update rule (standard HLC)

- **On a local structural event** (set `parentId` and/or `rank`):
  - `wallMs = max(prevWallMs, physicalNowMs)`
  - if `wallMs === prevWallMs` then `counter = prevCounter + 1` else `counter = 0`
  - `replicaId` = this replica's stable id
- **On receiving/merging a remote `move` `m`** (when reconciling the register locally):
  - `wallMs = max(localWallMs, m.wallMs, physicalNowMs)`
  - `counter` = per standard HLC merge: if `wallMs === localWallMs === m.wallMs` →
    `max(localCounter, m.counter) + 1`; if `wallMs === localWallMs` → `localCounter + 1`;
    if `wallMs === m.wallMs` → `m.counter + 1`; else `0`
  - This keeps the local clock monotonic and ahead of anything it has observed.

`replicaId` is generated once per client install (persisted in IndexedDB) and is **not** the
user id — one user on two devices is two replicas.

## Consequences

- **Easier / correct:** deterministic convergence for concurrent moves without a coordinator;
  moves and text edits are independent (no field-level stomping); recent intent wins under sane
  clocks; a badly-skewed device cannot silently and permanently win because its `wallMs` is
  reconciled upward on every merge it participates in.
- **Newly required:** the client MUST maintain the HLC on **every** structural write and MUST
  advance it on merge (ADR-0008 lists this as a client obligation); `replicaId` MUST be stable
  and persisted; the materializer records the winning `move` (or its derived `version`) so the
  server projection matches the CRDT's chosen winner.
- **Bounded skew caveat:** HLC bounds divergence between logical and physical time only while
  device clocks stay within a sane window. A device with an extreme forward-set clock can push
  `wallMs` far ahead and keep winning until real time catches up. This is an accepted V1 limit;
  monitoring/clamp of implausible `wallMs` jumps is a decide-during-build hardening, not a V1
  blocker.

## Alternatives considered

- **Bare wall-clock timestamp (LWW by `Date.now()`):** no deterministic tie-break → replicas
  can diverge; fully at the mercy of device clock skew. Rejected.
- **Pure Lamport clock:** deterministic but ignores real time, so stale offline edits can beat
  fresh ones in a way users perceive as wrong. Rejected — HLC keeps the determinism and adds
  real-time sanity.
- **Server-assigned sequence numbers:** would make the server authoritative for move order,
  contradicting **CRDT decides, Postgres records** (ADR-0004) and breaking offline moves that
  must resolve with no server. Rejected.

## Cross-references

- [ADR-0008](./0008-yjs-document-schema.md) — the `move` register lives on each item node.
- [ADR-0004](./0004-crdt-decides-postgres-records.md) — why the clock must be client-resolvable.
- [ADR-0005](./0005-fractional-indexing-ordering.md) — `rank` is one of the two fields `move` guards.
- [sync-and-conflict-resolution.md](../sync-and-conflict-resolution.md) — merge semantics narrative.
