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

- **Structure** lives in a `Y.Map<itemId, { parentId, rank, type, ... }>`. This is where
  LWW-parent and list-order merges resolve. → [04-sync](./sync-and-conflict-resolution.md)
- **Rich content** lives in a `Y.Text` (or fragment) per item, bound to TipTap.
- The Yjs doc — **not Postgres** — owns all of this. Postgres never sees an unresolved state.

## Who writes the `items` rows — the mechanics

1. **Hocuspocus persists the raw Yjs updates** (binary state / `yjs_updates`). This is the
   durable collab truth and what a reconnecting client syncs against. If the projection is
   lost, this is not.
2. **A debounced hook materializes the projection.** On `onChange` (or `onStoreDocument`),
   the materializer:
   - reads the current `Y.Map` of items,
   - diffs it against the last-projected snapshot for that document,
   - emits `INSERT ... ON CONFLICT (id) DO UPDATE` for changed items,
   - sets `deleted_at` for keys that disappeared,
   - extracts plain text from each item's `Y.Text` into `content_text` (feeds search).
   Debounce (~200–500ms) so a burst of keystrokes produces **one** projection pass.
3. **Serialize per document.** Take an advisory lock on `hashtext(document_id)` so two
   Hocuspocus workers can't interleave upserts for the same document.
4. **Idempotent and rebuildable.** Same CRDT state → same rows. A full rebuild (drop rows,
   re-project from Yjs) repairs a divergent projector and powers migrations.

## Hard rules

- **Never edit `items` to change structure.** Such a write is silently overwritten on the
  next projection pass. Structure changes go through the CRDT only. → [10-api](./api-and-write-path.md)
- **The projector never resolves conflicts.** By the time it runs, the CRDT has already
  merged. If a projected write hits a constraint (one-root, RESTRICT), that's a **projector
  bug**, not a conflict — fix the projector, don't loosen the constraint.
- **No DB-side structural mutation.** No cascades; deletes are tombstones the projector
  writes, and physical deletion is a separate GC job. → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)

## Durability & recovery

| Artifact | Role | If lost |
|----------|------|---------|
| `yjs_updates` (raw CRDT) | Source of truth | **Catastrophic** — this is the real data. Back it up. |
| `items` + projection tables | Query cache | Rebuildable from `yjs_updates`; just re-project. |

This asymmetry is the point: back up the CRDT plane hardest; treat the projection as a
cache you can regenerate.

## Open implementation questions (to resolve during build)

- Exact debounce window and whether to also project on an interval as a safety net.
- Whether descendant tombstoning is done eagerly (mark all) or lazily (mark root, filter at
  read). → [04-sync](./sync-and-conflict-resolution.md)
- Snapshot strategy for the "last projected state" diff base (in-memory per worker vs. a
  stored snapshot).
