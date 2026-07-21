# ADR-0011 — Delete is a CRDT register, not a missing key

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

Three documents describe delete in mutually incompatible ways:

- **`yjs-schema.md` / ADR-0008** pin the item node's fields and list **no delete state** at
  all. Delete is invisible on the source-of-truth plane.
- **`yjs-projection.md`** says the materializer "sets `deleted_at` for keys that disappeared"
  — i.e. it infers deletion from a **missing `Y.Map` key**.
- **ADR-0006** says user delete "sets `deleted_at`," undo "clears `deleted_at`," and a
  tombstone must be **retained through a retention window** so offline replicas converge.

These cannot all hold. A **missing key carries no data** — no timestamp, no `move` clock, no
content, no subtree. From "the key is gone" the projector cannot:

- decide undo vs. re-create (there is nothing to clear `deleted_at` *back* to),
- converge with an **offline replica** that never saw the delete — that replica still has the
  key, so on merge Yjs treats the deleter's absence as "no opinion" and the item **resurrects**
  (the exact failure ADR-0006 exists to prevent),
- retain the tombstone for the retention window — a missing key is already gone.

Deleting a key from a `Y.Map` is also not even a reliable delete in Yjs: a concurrent edit to
that item on another replica re-establishes the key. Delete-by-absence is a non-convergent
operation dressed up as one. This is Critical finding #3.

## Decision

**Delete is an explicit LWW register on the item node, guarded by its own HLC — never the
absence of a key.** The relational `deleted_at` is the *projection* of that register, not the
authority.

### Schema change — add a `deleted` register

```
itemNode (Y.Map):
  move    : Y.Map     — atomic structural register (ADR-0010)
  deleted : Y.Map      — the tombstone register
    isDeleted : boolean   — LWW; true = tombstoned
    hlc       : Y.Map      — { wallMs, counter, replicaId } (ADR-0009)
  type        : string
  content     : Y.Text
  isCompleted : boolean
  isCollapsed : boolean
  note        : Y.Text?
```

- **Delete** sets `deleted = { isDeleted: true, hlc: <fresh> }` in one transaction. The item's
  `Y.Map` key and all its other fields **stay in the document** — the tombstone is data, not
  a gap.
- **Undo** sets `deleted = { isDeleted: false, hlc: <fresh, strictly greater> }`. Because undo
  carries a newer HLC, it deterministically beats the delete on every replica, including one
  that is still catching up.
- **Convergence:** an offline replica that never saw the delete holds an older `deleted.hlc`;
  on merge, the delete's greater HLC wins and the item tombstones everywhere. No resurrection.
- **Subtree delete** tombstones the subtree **root** only (sets its `deleted` register).
  Descendants are treated as deleted at read time by walking up to the nearest tombstoned
  ancestor (lazy), OR the client may tombstone each descendant explicitly (eager). The
  eager-vs-lazy choice is the same open `GC` decision ADR-0006 already owns — this ADR only
  fixes *where the fact lives*, not the descendant strategy.

### Projection

The materializer reads `deleted.isDeleted` and writes:

- `items.deleted_at = <server clock at projection>` when `isDeleted` flips true (first time),
- `items.deleted_at = NULL` when it flips back to false (undo).

`deleted_at` is a **server-assigned projection timestamp** for query/retention use; the
**authoritative delete fact and its ordering live in the CRDT `deleted` register**. This keeps
ADR-0006's "back up the CRDT plane hardest" honest — the tombstone survives in `yjs_updates`,
not only in a projected column that a rebuild would have to reconstruct.

### GC and the CRDT tombstone

Physical GC (ADR-0006) hard-deletes the `items` row **and** removes the item's key from the
Yjs document, but only *after* the retention window guarantees all known replicas have merged
past the `deleted` register. Removing the CRDT key before that window is what caused
resurrection; removing it *after* is safe because every replica already holds `isDeleted:
true` with a dominant HLC. GC is thus the *one* place a key legitimately disappears, and it
disappears from an already-converged tombstone.

## Consequences

- **Correct:** offline delete converges instead of resurrecting; undo is a real inverse with
  deterministic ordering; the tombstone is durable CRDT data, not an inference; a full
  projection rebuild reconstructs `deleted_at` from the register instead of guessing.
- **Newly required:** the item node gains a `deleted` register the editor binding must set on
  delete/undo; the projector reads it instead of diffing key-presence; GC coordinates CRDT-key
  removal with the retention window.
- **Amends ADR-0006:** "user delete sets `deleted_at`" is restated as "user delete sets the
  CRDT `deleted` register, which projects to `deleted_at`." The retention/GC split is
  unchanged. **Amends ADR-0008 / `yjs-schema.md`** to add the register. **Corrects
  `yjs-projection.md`** to stop inferring deletion from missing keys.
- **Migration impact:** `items.deleted_at` already exists (0001); no relational change
  required. A `deleted` provenance is available via the register if per-field auditing is
  later wanted (additive, like ADR-0009's `move_hlc`).

## Alternatives considered

- **Delete-by-missing-key (status quo):** non-convergent (resurrection), no undo target, no
  retained tombstone. Rejected — it is the bug.
- **Yjs's built-in `Y.Map.delete` + rely on the CRDT's internal tombstone:** Yjs *does* keep
  an internal deletion marker, but it is not a user-undoable, HLC-ordered, projectable fact —
  a concurrent edit resurrects the key, and we cannot attach our own undo semantics or
  retention window to it. Rejected in favor of an explicit application-level register.
- **API-plane-only delete (set `deleted_at` via REST, never touch Yjs):** delete would live
  off the source-of-truth plane, so an offline client editing the same item would not see it
  and would diverge; contradicts "CRDT decides" (ADR-0004). Rejected.

## Cross-references

- [ADR-0004](./0004-crdt-decides-postgres-records.md) — why the delete fact must live in the CRDT.
- [ADR-0006](./0006-soft-delete-and-tombstone-gc.md) — the soft-delete + GC split this makes convergent.
- [ADR-0008](./0008-yjs-document-schema.md) — the schema this amends.
- [ADR-0009](./0009-move-clock-hlc.md) — the HLC the `deleted` register reuses.
- [yjs-schema.md](../yjs-schema.md) · [yjs-projection.md](../yjs-projection.md) — corrected to match.
