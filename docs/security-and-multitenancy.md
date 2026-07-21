# 11 — Security & Multi-Tenancy

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

Tenancy, permissions, and the authorization boundaries. Mirrors report §"Multi-Tenancy,
Permissions, Sync".

## Tenancy model

```
Workspace (tenant boundary)
   └── Document
         └── Item
```

The **workspace is the tenant boundary.** Every query, every index, and every authz check
scopes under it. There is no cross-workspace read path in the product.

## Hard rules

1. **Document-scoped everything.** All hot indexes lead with `document_id`; all reads filter
   by `document_id` / workspace **first**. This is both a performance rule
   ([03-data-model](./data-model.md)) and a security rule — it makes a cross-tenant scan
   structurally unlikely.
2. **Authz at both edges.** Both the **REST/RPC API** and the **WebSocket (Hocuspocus)**
   connection MUST authenticate and authorize. A user opening a Yjs document over the socket
   is an access-control decision, not just a transport one — enforce it in a Hocuspocus
   `onAuthenticate`/`onConnect` hook, not only at the REST layer.
3. **No cross-tenant query unscoped.** Any query that doesn't lead with workspace/document is
   a bug. → [10-api](./api-and-write-path.md) forbidden operations.
4. **Presigned URLs for blobs.** S3 credentials never reach the client; the server signs
   time-limited PUT/GET and enforces size/MIME at signing. → [09-attachments](./attachments.md)

## Permissions

- **V1:** workspace membership + per-document access (owner / editor / viewer is sufficient
  to ship). Keep it coarse.
- **V2:** **permission inheritance down the tree** via the closure table — a permission set
  on an item applies to its subtree. This is one of the concrete reasons closure exists in
  the schema. → [03-data-model](./data-model.md), [ADR-0003](./adr/0003-hierarchy-adjacency-plus-closure.md)

## Auth

- Sessions or JWT at the API/WS edge (standard). Presence/awareness and permission checks
  layer on top of Yjs — we own that logic (accepted cost of choosing Yjs over a hosted
  realtime DB). → [02-tech-stack](./tech-stack.md)

## Data-at-rest & recovery posture

- **Back up the CRDT plane hardest.** `yjs_updates` is the real data; the `items` projection
  is a rebuildable cache. Backup and retention policy must reflect that asymmetry.
  → [06-yjs-projection](./yjs-projection.md)
- **Soft-delete retention window** must be long enough that all known replicas sync past a
  tombstone before GC hard-deletes — a correctness property, not just a UX one.
  → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)

## Self-hosting posture

The whole system self-hosts from Postgres + S3 (MinIO) + the Node services. No hosted-auth
or hosted-DB dependency is on the V1 critical path — consistent with the "own your data"
principle. → [00-product-overview](./product-overview.md)

## Open questions (resolve during build)

- Exact permission granularity for V1 (document-level roles vs. also item-level).
- Whether awareness/presence leaks any content to unauthorized viewers (audit the Yjs
  awareness payload).
- Rate-limiting and abuse controls on the presign and WS-connect endpoints.
