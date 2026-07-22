# 10 — API & Write Path

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

How writes flow through the system, and the command surface the app exposes. Mirrors report
§"Write Path Design".

## The cardinal rule

**Clients never write SQL, and structure is never mutated by writing `items` directly.**
Clients speak two protocols:

- **Yjs (over WebSocket)** — for outline structure and text content. This is the write path
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
| `InsertItem(parent, afterRank, content)` | New item; sets its `move` register (parent + rank + HLC) in one transaction; (closure rows in V2) |
| `UpdateItem(id, fields, version)` | Content/metadata only (optimistic concurrency via `version`) |
| `MoveItem(id, newParent, newRank)` | Replace the item's atomic `move` register (parent + rank + fresh HLC) in one transaction; deterministic cycle repair on merge (ADR-0010/0012) |
| `DeleteItem(id)` | **Soft**-delete: set the subtree root's CRDT `deleted` register (ADR-0011); projects to `deleted_at` |
| `MirrorItem(target, parent, rank)` | `item_refs` row (V2) |

Structural commands (`InsertItem`, `MoveItem`, `DeleteItem`, `MirrorItem`) are realized as
**Yjs mutations** that the materializer projects. `UpdateItem` for pure metadata may also go
through the API/projection with `version` for optimistic concurrency.

## Write flow (end to end)

```
UI command (e.g. MoveItem)
   │
   ▼
Yjs mutation (replace the item's atomic move register)   ── applies locally, instant
   │  websocket
   ▼
Hocuspocus merge (LWW on whole move via HLC, deterministic cycle repair)   ← conflicts resolved HERE
   │  persist raw update → yjs_updates
   │  onChange (debounced)
   ▼
Materializer → items upsert   (advisory lock + monotonic projected_rev, ADR-0013)
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

## API shape — single `/rpc` endpoint (decided)

The non-CRDT API is a **single `POST /rpc` endpoint** dispatching typed commands (queries, auth,
attachment presign, workspace/settings). Structure and text ride the Yjs plane, so this API
mostly wraps reads, auth, and presign — a single typed dispatch is lighter to extend than a
spread of resource routes for what is largely a command surface. Decided resolutions:

- **Transport:** one `/rpc` endpoint with typed commands (not REST resource routes).
- **`UpdateItem` plane:** pure content/metadata `UpdateItem` may ride the API/projection with
  `version` optimistic concurrency; all *structural* fields stay CRDT-only.
- **Subtree-load default:** **load-on-expand** — reads return a bounded depth and children load
  as the user expands, rather than shipping an entire large outline in one response.

## Open questions (resolve during build)

- Exact `/rpc` command schema and error envelope (validation, typed error codes).
- Depth/pagination limits (the exact default depth and page size for load-on-expand).
