# ADR-0015 — Yjs persistence boundary: ack-after-persist, snapshots, compaction

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

`yjs-projection.md` pinned the *projection* side of the pipeline (materializer, monotonic
`projected_rev`, catch-up sweep — ADR-0013) but explicitly left the **persistence boundary**
— what Hocuspocus does with a raw Yjs update *before* projection — as four open decisions.
That boundary is where the system's most important durability promise lives: `yjs_updates` is
the real outline data, the thing the recovery posture says to "back up hardest." If the
persistence layer is sloppy, projection correctness is irrelevant — the source of truth is
already lost or unbounded.

Four questions were open:

1. **Ack ordering** — does the server confirm an update to the client before or after it is
   durably stored?
2. **Update ordering & dedup** — are `yjs_updates` rows deduplicated / ordering-checked, or is
   the store replay-tolerant?
3. **Snapshots & compaction** — how does room-load time stay bounded as update history grows?
4. **Corruption detection & replay** — how is a corrupt/partial update detected and the room
   rebuilt?

## Decision

### 1. Acknowledge-after-persist (durable ack)

**The server MUST NOT acknowledge a Yjs update to the client until that update is durably
committed to `yjs_updates`** (fsync/transaction commit, not just buffered in memory). The
Hocuspocus store write happens first; only then does the update propagate as acked to other
peers and count as received.

- A crash between "received" and "persisted" therefore loses only *un-acked* updates — the
  client still holds them in its `y-indexeddb` store and re-sends on reconnect. No **acked**
  update is ever lost. This is the one guarantee the "back up the CRDT hardest" posture cannot
  compromise on.
- The trade is a small write-latency floor on each update batch (a disk commit before ack). We
  accept it: outline edits are not latency-critical to the millisecond, and the client already
  applies its own edit **locally and instantly** (offline-first, ADR-0002) — the server ack is
  a durability signal, not a render gate.

### 2. Replay-tolerant store, snapshot-bounded (no strict dedup requirement)

- Yjs merge is **idempotent and commutative**, so applying the same update twice is harmless
  for correctness. The store therefore does **not** need strict per-update dedup or a total
  ordering check to be correct.
- What duplicates *do* cost is **load time and storage** (an unbounded pile of incremental
  updates to replay on room open). That is a performance problem, and we solve it with
  compaction (below), not with a dedup index on the hot write path.

### 3. Snapshots + compaction (bounded room load)

- Periodically (by update count and/or age) the server writes a **snapshot**:
  `Y.encodeStateAsUpdate(doc)` persisted as a single compacted row, then **truncates the
  incremental updates it supersedes** in the same transaction.
- Room load = load latest snapshot + replay only the incremental updates newer than it, so
  load time stays **bounded by the compaction interval**, not by total document history.
- Compaction is **safe against the durable-ack rule**: it only ever *replaces* a set of
  already-persisted, already-acked updates with an equivalent snapshot — it never drops an
  un-superseded update. Run it under the same per-document advisory lock the projector uses
  (`hashtext(document_id)`) so it can't interleave with a concurrent write/projection.

### 4. Corruption detection → rebuild from last good snapshot

- Each stored update/snapshot carries an integrity check (e.g. a checksum) written at persist
  time. On room load, a row that fails to decode or apply is treated as **corrupt**, not fatal.
- Recovery: **rebuild the room from the last good snapshot** plus the incremental updates that
  still apply cleanly, skipping the corrupt row and logging it. Because snapshots are periodic
  and updates are idempotent, the worst-case loss is bounded to whatever a single corrupt
  incremental row uniquely contributed since the last snapshot — and a client still holding
  that edit locally re-syncs it.
- This is the CRDT-plane analogue of the projection's catch-up sweep (ADR-0013): detect a bad
  state, reconstruct from the durable base, never hard-fail the room.

## Consequences

- **Easier / correct:** the durability promise is now precise — *acked ⇒ durable* — so backup
  and recovery reason about a well-defined set; room-load stays bounded regardless of edit
  volume; a corrupt update degrades to bounded, logged loss instead of a dead room.
- **Newly required:** a store implementation that commits-before-ack (Hocuspocus
  `onStoreDocument` / a store adapter that fsyncs); a compaction job (count/age-triggered,
  advisory-locked, snapshot-then-truncate); an integrity check on stored rows and a
  load-time rebuild path; metrics for updates-since-snapshot and compaction lag.
- **Accepted downsides:** a per-batch disk-commit latency floor before ack (deliberate, see
  above); snapshot storage overhead (bounded — old incrementals are truncated); compaction is
  one more background job to operate (co-located with GC and the catch-up sweep under `OPS`).
- **Interaction with projection (ADR-0013):** unchanged. The projector still reads merged CRDT
  state and advances `projected_rev` monotonically; compaction changes *how* `yjs_updates` is
  stored, not what the projector sees. `source_rev` continues to advance on each persisted
  update or snapshot.

## Alternatives considered

- **Ack-on-receive (persist asynchronously):** lower latency, but a crash in the receive→persist
  gap silently loses an update the client already believes is safe — unacceptable for the
  source-of-truth plane. Rejected.
- **Ack-after-persist but no compaction:** durable, but room-load time grows without bound as
  history accumulates — fine only if every document stays tiny, which we can't assume. Rejected
  in favor of pairing durability with compaction from the start.
- **Strict per-update dedup + total-order log:** buys nothing for CRDT correctness (merge is
  idempotent) while adding write-path cost and a uniqueness index to maintain. Rejected;
  compaction addresses the real cost (load/storage) more directly.

## Cross-references

- [yjs-projection.md](../yjs-projection.md) — the projection side; this ADR closes its "Open decisions — Yjs persistence boundary" block.
- [ADR-0013](./0013-projection-revision-guard.md) — monotonic projection + catch-up sweep (the projection-plane analogue of corruption recovery).
- [ADR-0004](./0004-crdt-decides-postgres-records.md) — CRDT decides, Postgres records; why `yjs_updates` is the source of truth.
- [ADR-0002](./0002-sync-engine-yjs-vs-localfirst.md) — Yjs/Hocuspocus as the sync engine.
- [security-and-multitenancy.md](../security-and-multitenancy.md) — recovery posture: back up `yjs_updates` with the authoritative relational/blob planes.
- [self-hosting.md](../self-hosting.md) — where the compaction/GC jobs and their metrics are operated.
