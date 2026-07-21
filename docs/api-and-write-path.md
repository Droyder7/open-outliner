# 10 — API & Write Path

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

How writes flow through the system, and the command surface the app exposes. Mirrors report
§"Write Path Design".

## The cardinal rule

**Clients never write SQL, and structure is never mutated by writing `items` directly.**
Clients speak two protocols:

- **Yjs (over WebSocket)** — for outline structure and rich text. This is the write path
  for anything that is part of the tree.
- **REST/RPC API** — for queries, auth, attachment presigning, workspace/settings, and other
  non-CRDT operations.

A direct SQL write to `items` would be silently overwritten by the next projection pass
([06-yjs-projection](./yjs-projection.md)), so the command surface below is expressed as
**intent** that flows into the CRDT, not as row edits.

## Command surface

The service-level commands (not raw SQL from the client):

| Command | Effect |
|---------|--------|
| `InsertItem(parent, afterRank, content)` | New item; rank between neighbors; (closure rows in V2) |
| `UpdateItem(id, fields, version)` | Content/metadata only (optimistic concurrency via `version`) |
| `MoveItem(id, newParent, newRank)` | Relink + cycle check + (closure/`path` fix in V2) |
| `DeleteItem(id)` | **Soft**-delete subtree (flag root, or all via closure) |
| `MirrorItem(target, parent, rank)` | `item_refs` row (V2) |

Structural commands (`InsertItem`, `MoveItem`, `DeleteItem`, `MirrorItem`) are realized as
**Yjs mutations** that the materializer projects. `UpdateItem` for pure metadata may also go
through the API/projection with `version` for optimistic concurrency.

## Write flow (end to end)

```
UI command (e.g. MoveItem)
   │
   ▼
Yjs mutation (parentId + rank registers)   ── applies locally, instant
   │  websocket
   ▼
Hocuspocus merge (LWW parent, list order, cycle reject)   ← conflicts resolved HERE
   │  persist raw update → yjs_updates
   │  onChange (debounced)
   ▼
Materializer → items upsert   (advisory lock on hashtext(document_id))
   │
   ▼
API reads see the new projection
```

Conflicts are resolved at the CRDT merge, never in the API or the DB.
→ [04-sync-and-conflict-resolution](./sync-and-conflict-resolution.md)

## Serialization & concurrency

- **Hierarchy mutations are serialized per document** — advisory lock on
  `hashtext(document_id)` — so rank/closure writes can't race under multiplayer + offline
  replay.
- **Optimistic concurrency** (`items.version`) guards API-plane metadata writes.
- **Idempotency:** API mutations carry a client-generated id so Background-Sync retries don't
  double-apply. → [07-offline-and-pwa](./offline-and-pwa.md)

## Forbidden operations (API layer)

- ❌ Raw `DELETE` on `items` — races concurrent LWW move-ins; use soft-delete.
  → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)
- ❌ Direct `INSERT`/`UPDATE` of `parent_id`/`rank` outside the projector — overwritten next pass.
- ❌ Any cross-tenant query not scoped by workspace/document first.
  → [11-security-and-multitenancy](./security-and-multitenancy.md)

## Surfacing outcomes to users

When a concurrent move loses the LWW, or a mirror is created instead of a move, the app
SHOULD surface it — activity history or a small conflict note — so the result never feels
arbitrary. → [04-sync](./sync-and-conflict-resolution.md)

## Open questions (resolve during build)

- Exact REST vs RPC shape (single `/rpc` endpoint vs. resource routes).
- Whether `UpdateItem` metadata rides the Yjs plane too, or stays API-only.
- Pagination/depth-limit defaults for subtree loads (report recommends load-on-expand).
