# ADR-0013 — Projection revision guard & catch-up reconciliation

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

The materializer projects merged Yjs state into `items` from a **debounced Hocuspocus
`onChange` hook**, serialized per document by an advisory lock on `hashtext(document_id)`
(ADR-0004, `yjs-projection.md`). Two failure modes make that projection **regress** or
**stall indefinitely** — Critical finding #5.

1. **Stale-callback regression.** Debounce + async means callbacks can be reordered. Suppose
   state `v5` fires a debounced projection, then `v6` fires another. If the `v5` callback was
   delayed (GC pause, slow scheduler, a second Hocuspocus worker) and acquires the advisory
   lock *after* the `v6` callback already committed, it overwrites the rows with **older `v5`
   state**. The advisory lock guarantees the two passes don't *interleave*; it does **not**
   guarantee they run in **version order**. The projection silently goes backwards.

2. **Crash-in-the-gap stall.** Hocuspocus persists the raw update to `yjs_updates` (durable
   truth) *before* the debounced projection runs. If the server crashes — or the worker is
   evicted — in that window, the update is durable but **never projected**. Nothing re-triggers
   it: `onChange` already fired for that version. The projection is now **permanently stale**
   for that document until some unrelated future edit happens to re-fire the hook, which may be
   never. Search and API reads serve indefinitely old rows.

The projection doc lists "snapshot strategy" and "project on an interval as a safety net" as
*open questions*. They are not optional niceties — without them the projection is neither
monotonic nor eventually-consistent with the CRDT.

## Decision

**The projection carries a persistent, monotonic revision per document. A pass applies only if
it advances that revision, and a periodic + startup catch-up sweep re-projects any document
whose source revision is ahead of its projected revision.**

### Two revisions per document

- **`source_rev`** — advances every time Hocuspocus persists an update for the document. It is
  derived from the durable CRDT plane, e.g. the max `yjs_updates.id` (a `BIGSERIAL`) applied,
  or the Yjs state-vector hash. It answers "how current is the truth?"
- **`projected_rev`** — the `source_rev` the `items` rows were last projected from. It answers
  "how current is the cache?"

Both live in a small durable table keyed by `document_id` (see migration 0002). A document is
**up to date** iff `projected_rev == source_rev`, and **behind** iff `projected_rev <
source_rev`.

### Monotonic apply (fixes regression)

Every projection pass, under the existing per-document advisory lock:

1. Read the current `source_rev` (call it `S`) and the stored `projected_rev` (call it `P`).
2. **If `S <= P`, do nothing and release** — a newer or equal pass already ran; this callback
   is stale. This is the guard that makes a delayed `v5` callback a **no-op** once `v6`
   committed, instead of an overwrite.
3. Otherwise project the current merged state and, in the **same transaction** as the row
   upserts, set `projected_rev = S`. The revision advance and the rows it describes commit
   atomically, so a crash mid-pass leaves `projected_rev` unadvanced and the pass simply reruns.

Projection stays **idempotent** (ADR-0004): re-running for the same `S` yields the same rows;
the guard only prevents *older* passes from winning.

### Catch-up sweep (fixes the crash-in-the-gap stall)

A background reconciler, independent of `onChange`:

- **On worker startup**, and **on a periodic interval** (the "project on an interval as a
  safety net" the doc flagged), scans for documents where `projected_rev < source_rev` and
  enqueues a projection pass for each under the advisory lock.
- This is the **only** thing that recovers a document whose `onChange` was lost to a crash: the
  durable `source_rev` moved but `projected_rev` didn't, so the sweep catches it regardless of
  whether any new edit ever arrives.
- The sweep uses the same monotonic-apply path, so it composes safely with live `onChange`
  passes and multiple workers — whoever holds the lock and sees `S > P` wins; everyone else
  no-ops.

### Rebuild is `projected_rev = 0`

A full rebuild (ADR-0004, and the FK-safe procedure in `yjs-projection.md`) is just resetting
`projected_rev` below `source_rev` and letting the sweep re-project from current Yjs state — no
special path.

## Consequences

- **Correct:** the projection is **monotonic** (never serves older-than-last state) and
  **eventually consistent** (the sweep guarantees every durable update is projected, even
  across crashes); multi-worker Hocuspocus is safe because the lock + revision compare is the
  single arbiter.
- **Newly required:** a durable `document_projection` row per document (migration 0002); the
  materializer reads/writes `projected_rev` transactionally with its upserts; a reconciler
  loop on an interval and at startup. The debounce window itself stays a tuning knob, no longer
  a correctness risk.
- **Turns three `yjs-projection.md` "open implementation questions" into decisions:** the
  interval safety-net (now required), the snapshot/diff base (keyed by `projected_rev`), and
  monotonic serialization. Builds on ADR-0004's per-document lock and idempotent projection.
- **Observability hook:** `source_rev - projected_rev` per document is a ready-made **projection
  lag** metric for the `OPS` monitoring gap.

## Alternatives considered

- **Advisory lock alone (status quo):** serializes passes but not their order — a late older
  callback still overwrites. No mechanism recovers a crash-lost projection. Rejected — it is
  the bug.
- **In-memory "last projected version" per worker:** lost on restart and not shared across
  workers, so it neither survives the crash case nor coordinates multiple Hocuspocus
  processes. Rejected for a durable per-document revision.
- **Project synchronously in `onChange`, no debounce:** removes the gap but defeats the
  batching that makes a keystroke burst one pass, and still regresses under multi-worker
  reordering without a revision compare. Rejected.
- **Rely on a periodic full re-projection of every document:** the sweep handles the tail, but
  full re-projection of *all* docs on an interval is wasteful; scanning `projected_rev <
  source_rev` touches only stale docs. The revision compare is what makes the sweep cheap.

## Cross-references

- [ADR-0004](./0004-crdt-decides-postgres-records.md) — the materializer + advisory-lock model this hardens.
- [yjs-projection.md](../yjs-projection.md) — mechanics; its open questions are resolved here.
- [ADR-0011](./0011-crdt-tombstone.md) — tombstone projection also rides the monotonic pass.
- [`/migrations/0002_integrity_v1.sql`](../../migrations/0002_integrity_v1.sql) — the `document_projection` table.
