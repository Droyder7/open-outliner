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
2. **Authz at both edges, and for both read and write.** Both the **REST/RPC API** and the
   **WebSocket (Hocuspocus)** connection MUST authenticate and authorize. A user opening a Yjs
   document over the socket is an access-control decision, not just a transport one — enforce it
   in a Hocuspocus `onAuthenticate`/`onConnect` hook. **Connecting is not the same as
   editing:** a `viewer`/`commenter` who is authorized to *open* a room can still emit Yjs
   updates over that socket unless writes are separately gated. Enforce role at the update
   boundary — reject or drop inbound updates from non-editor roles in a Hocuspocus
   `onChange`/`beforeHandleMessage`-style hook (a read-only connection), not only at
   `onAuthenticate`. Read authorization gates the connection; write authorization gates each
   update.
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

"Sessions or JWT" is a transport choice, not the identity model. These are **decide-during-build
but must-not-ship-without** — track under `SEC` in [status.md](./status.md):

- **Identity & membership** — the user record and `document_members`/workspace membership are
  authoritative relational data (not in Yjs); invitation, role assignment, and removal flows
  are undefined and required for the collaboration journey. → [product-overview](./product-overview.md)
- **Revocation** — removing a member MUST invalidate their live WS connection and future
  presigns. If using stateless JWTs, define expiry + a revocation/denylist path, or keep a
  server-side session that can be killed; a long-lived JWT that outlives a `document_members`
  delete is a hole.
- **WebSocket credential** — how the API session/JWT is presented to Hocuspocus
  `onAuthenticate`, and how it is re-checked on reconnect (an offline client reconnecting after
  its access was revoked MUST be rejected).
- **CSRF / credential expiry** for the REST edge; **rate-limiting** on presign and WS-connect
  (already an open question below).
- **Offline access loss.** A client that edited offline and *then* lost access MUST have its
  queued Yjs updates and mutation-outbox writes **rejected server-side on reconnect** (the
  write-authz gate above is the enforcement point); locally cached content is best-effort
  purged on next successful auth, but the security boundary is the server rejecting the
  replay, not the client deleting its cache. → [07-offline-and-pwa](./offline-and-pwa.md)

## Data-at-rest & recovery posture

- **Back up the CRDT plane hardest, but not *only*.** `yjs_updates` is the real outline data
  and the `items` projection is a rebuildable cache — **but** `workspaces`, `documents`,
  `document_members`, and `attachments` metadata (plus the S3 objects themselves) are
  **authoritative relational/blob data that is NOT in Yjs and NOT rebuildable from it.** A
  Yjs-only restore brings back outline structure and text but orphans it: no tenancy, no
  membership, no attachment resolution. A coherent backup/restore captures **all authoritative
  planes together** (`yjs_updates` + tenancy/membership tables + `attachments` + S3), and
  restore order matters (tenancy → items projection rebuild → attachments). → [06-yjs-projection](./yjs-projection.md)
  durability table, [01-architecture-overview](./architecture-overview.md) recovery.
- **Soft-delete retention window** must be long enough that all known replicas sync past a
  tombstone before GC hard-deletes — a **replica-acknowledgement** bound, not a bare wall
  clock — a correctness property, not just a UX one.
  → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md), [ADR-0011](./adr/0011-crdt-tombstone.md)

## Self-hosting posture

The whole system self-hosts from Postgres + S3 (MinIO) + the Node services. No hosted-auth
or hosted-DB dependency is on the V1 critical path — consistent with the "own your data"
principle. → [00-product-overview](./product-overview.md)

## Open questions (resolve during build)

- Exact permission granularity for V1 (document-level roles vs. also item-level).
- Whether awareness/presence leaks any content to unauthorized viewers (audit the Yjs
  awareness payload).
- Rate-limiting and abuse controls on the presign and WS-connect endpoints.
