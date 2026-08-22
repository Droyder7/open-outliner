# 06 — Yjs → Relational Projection

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

This is the hardest integration point in the system and the one the research report
originally left implicit ("project Yjs into Postgres" — but *who* writes the rows?). This
doc names the component and pins the mechanics.

## Decision summary

- **The Yjs document is the source of truth** for outline structure and rich text.
- **A server-side materializer** — hosted in a **Hocuspocus `onChange` / `onStoreDocument`
  hook** — projects merged CRDT state into Postgres `items` rows.
- **Projection is debounced, idempotent, per-document-serialized, and rebuildable.**
- **Postgres is downstream and disposable:** you can drop and rebuild `items` for a
  document purely from Yjs state.

→ [ADR-0004](./adr/0004-crdt-decides-postgres-records.md)

## The pipeline

```
Client edits ──► Yjs doc (authoritative structure + text)
                    │  websocket (Hocuspocus)
                    ▼
        Hocuspocus persists raw Yjs updates ──► yjs_updates (durable CRDT truth)
                    │
                    │  onChange (debounced ~200–500ms)
                    ▼
        Materializer: diff Y.Map / Y.Array against last projected snapshot
                    │  → row upserts + tombstones
                    ▼
        PostgreSQL items (parent_id, rank, content, content_text, deleted_at)
                    │
                    ▼
        REST/RPC API, search, views  ── read the projection
```

## CRDT document shape

- **Structure** lives in a `Y.Map<itemId, itemNode>`. Each item's `parentId` and `rank` are
  carried inside one **atomic `move` register** (ADR-0010) gated by an HLC (ADR-0009), so the
  projector reads a whole winning move, never a torn `{parentId, rank}` pair. Delete is an
  explicit `deleted` register (ADR-0011), not a missing key.
  → [yjs-schema.md](./yjs-schema.md), [04-sync](./sync-and-conflict-resolution.md)
- **Content** lives in a `Y.Text` per item, bound directly (no TipTap/ProseMirror layer) — V1
  content is plain text, marks deferred to V2 ([ADR-0018](./adr/0018-plain-text-content-v1.md)).
- The Yjs doc — **not Postgres** — owns all of this. Postgres never sees an unresolved state.

## Who writes the `items` rows — the mechanics

1. **Hocuspocus persists the raw Yjs updates** (binary state / `yjs_updates`). This is the
   durable collab truth and what a reconnecting client syncs against. If the projection is
   lost, this is not.
2. **A debounced hook materializes the projection.** On `onChange` (or `onStoreDocument`),
   the materializer:
   - reads the current `Y.Map` of items,
   - diffs it against the last-projected snapshot for that document,
   - emits `INSERT ... ON CONFLICT (id) DO UPDATE` for changed items, reading each item's
     `move` register as a unit so `parent_id` and `rank` always come from the *same* winning
     move (ADR-0010),
   - projects each item's `deleted` register (ADR-0011) to `deleted_at` — a set
     `isDeleted:true` writes the server timestamp, an undo (`isDeleted:false`) clears it.
     **Deletion is never inferred from a missing key** — a tombstone is explicit CRDT data,
     which is what lets an offline delete converge instead of resurrecting,
   - extracts plain text from each item's `Y.Text` into `content_text` (feeds search).
   Debounce (~200–500ms) so a burst of keystrokes produces **one** projection pass.
3. **Serialize per document, and apply monotonically.** Take an advisory lock on
   `hashtext(document_id)` so two Hocuspocus workers can't interleave upserts for the same
   document. Under that lock, apply a pass **only if it advances** the document's
   `projected_rev` past `source_rev` (ADR-0013) — a delayed older callback that arrives after a
   newer one sees `source_rev <= projected_rev` and **no-ops** instead of overwriting with
   stale state. The revision advance commits in the **same transaction** as the row upserts.
4. **Idempotent, rebuildable, and self-healing.** Same CRDT state → same rows. A startup +
   interval **catch-up sweep** re-projects any document where `projected_rev < source_rev`,
   recovering a projection lost to a crash between `yjs_updates` persistence and the debounced
   callback (ADR-0013). A full rebuild (drop rows, re-project from Yjs) repairs a divergent
   projector and powers migrations — see the FK-safe procedure below.

## Hard rules

- **Never edit `items` to change structure.** Such a write is silently overwritten on the
  next projection pass. Structure changes go through the CRDT only. → [10-api](./api-and-write-path.md)
- **The projector never resolves conflicts.** By the time it runs, the CRDT has already
  merged. If a projected write hits a constraint (one-root, RESTRICT, same-document parent),
  that means the resolving CRDT write has **not merged on this node yet** — it resolves on the
  next update. A **cycle** is not rejected: the CRDT layer repairs it deterministically
  (break the youngest edge, reparent the freed item to root, emit an ordinary `move`), and the
  projector's ancestor check only detects and, if the server is a participating replica, emits
  that repair — it never vetoes into a non-terminating loop (ADR-0012).
- **No DB-side structural mutation.** No cascades; deletes are tombstones the projector
  writes, and physical deletion is a separate GC job gated on replica acknowledgement
  ([ADR-0019](./adr/0019-replica-ack-gc-gating.md)) that removes BOTH the `items` row and the
  item's Yjs key — without the key removal the next projection pass would re-upsert the
  tombstone.
  → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)

## Durability & recovery

**"Disposable cache" applies only to the item projection — not to every table.** Be precise
about what is rebuildable from Yjs and what is authoritative relational data:

| Artifact | Role | If lost |
|----------|------|---------|
| `yjs_updates` (raw CRDT) | Source of truth for structure + text | **Catastrophic** — this is the real outline data. Back it up hardest. |
| `items` + `content_text` / `search_tsv` | Query cache derived from Yjs | Rebuildable from `yjs_updates`; just re-project (see below). |
| `document_projection` (revisions) | Projection bookkeeping | Rebuildable — reset `projected_rev = 0` and let the sweep re-project. |
| `workspaces`, `documents`, `document_members` | **Authoritative** tenancy/membership | **Not in Yjs, not rebuildable.** Back up with `yjs_updates`. Losing these orphans every doc. |
| `attachments` metadata + S3 objects | **Authoritative** blob plane | **Not in Yjs.** Coordinate backup with `yjs_updates`; an item's `move`/text survives a Yjs restore but its blobs do not. |
| `replica_sync` (sync-ack ledger) | Authoritative for the GC retention bound | **Not in Yjs.** Losing it forgets offline replicas, so GC can hard-delete a tombstone an offline replica hasn't synced (ADR-0019). Back it up with `yjs_updates` + tenancy. |

The asymmetry is real but **two-sided**: the item projection is a cache you regenerate; the
tenancy, membership, blob, and (since ADR-0019) replica-sync-ack planes are primary data that a
Yjs-only restore would **not** bring back. A coherent restore reconstitutes all authoritative
planes together — see [architecture-overview.md](./architecture-overview.md) recovery and
[security-and-multitenancy.md](./security-and-multitenancy.md).

## FK-safe rebuild procedure

"Drop `items` and re-project" is the mental model, but a literal `TRUNCATE items` fails: other
rows reference it (`documents.root_item_id RESTRICT`, `attachments.item_id RESTRICT`,
`item_tags ... CASCADE`, and `items.parent_id` self-reference). Rebuild **per document** so
FKs stay satisfied:

1. Take the per-document advisory lock and set `projected_rev = 0` for the document.
2. Re-derive the full item set from current Yjs state into the existing rows via **upsert**
   (`INSERT ... ON CONFLICT (id) DO UPDATE`), not drop-then-insert — this repairs divergent
   rows in place without violating the inbound FKs.
3. For item ids present in `items` but absent from Yjs (and past their tombstone), let the
   **GC path** remove them bottom-up under the same lock (ADR-0006) — the rebuild itself never
   issues a raw `DELETE` that could strand `documents.root_item_id` or an `attachments` row.
4. Advance `projected_rev` to the current `source_rev` in the same transaction.

Rebuilding by upsert-and-GC (never truncate) is what keeps the "disposable projection" claim
true in the presence of RESTRICT FKs.

## Resolved mechanics (were open questions)

- **Interval safety net — required, not optional.** The catch-up sweep runs at startup and on
  an interval (ADR-0013); it is the only thing that recovers a projection lost to a crash in
  the persist→debounce gap.
- **Snapshot / diff base** is keyed by `projected_rev` in `document_projection` (durable,
  shared across workers), not an in-memory per-worker snapshot.
- **Debounce window** (~200–500ms) stays a tuning knob — with the revision guard it is no
  longer a correctness risk, only a latency/batching trade-off.
- **Descendant tombstoning** is **lazy** (decided, ADR-0006/ADR-0011): delete sets the
  `deleted` register on the **subtree root only**; the projector and reads treat any item with a
  deleted ancestor as implicitly deleted (filter under a deleted ancestor), rather than writing
  a tombstone on every descendant. Cheap delete + cheap undo (flip one register).

## Yjs persistence boundary — decided ([ADR-0015](./adr/0015-yjs-persistence-boundary.md))

These gate the Hocuspocus persistence layer (not the projection logic above). All four are now
pinned in [ADR-0015](./adr/0015-yjs-persistence-boundary.md):

- **Acknowledge-after-persist.** The server MUST NOT ack a Yjs update to the client until it is
  durably committed to `yjs_updates` (fsync/commit). A crash in the receive→persist gap loses
  only *un-acked* updates, which the client still holds locally and re-sends — **no acked update
  is ever lost**. The trade is a small per-batch commit latency before ack; acceptable because
  the client already applies edits locally and instantly (the ack is a durability signal, not a
  render gate).
- **Replay-tolerant store, no strict dedup.** Yjs merge is idempotent/commutative, so the store
  does not need per-update dedup or ordering checks for correctness. Duplicates cost only load
  time and storage — addressed by compaction, not a hot-path uniqueness index.
- **Snapshots & compaction.** Periodically (by update count/age) write a
  `Y.encodeStateAsUpdate` snapshot and truncate the superseded incremental updates in the same
  transaction, under the per-document advisory lock. Room load stays bounded by the compaction
  interval, not total history. Compaction only replaces already-acked updates, so it never
  conflicts with the durable-ack rule.
- **Corruption detection → rebuild from last good snapshot.** Stored rows carry an integrity
  check; a row that fails to decode/apply is treated as corrupt (not fatal) and the room is
  rebuilt from the last good snapshot plus the still-valid incrementals — the CRDT-plane
  analogue of the projection catch-up sweep (ADR-0013).
