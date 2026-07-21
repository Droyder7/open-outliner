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

## Permissions — owner + equal workspace members (V1, decided)

**Decided ([ADR-0014](./adr/0014-session-auth-and-revocation.md)):**

- **V1:** each workspace has **one owner**; the owner invites **members** who each get **equal
  read-write access to every document** in the workspace. There are **no per-document roles**
  (no viewer/commenter/editor split) in V1 — sharing granularity is workspace-level. Real-time
  multiplayer is fully supported. Membership is authoritative **relational** data, never in Yjs.
- **V2:** per-document roles and **permission inheritance down the tree** via the closure table
  — a permission set on an item applies to its subtree. This is one of the concrete reasons
  closure exists in the schema, and nothing in the V1 model forecloses it.
  → [03-data-model](./data-model.md), [ADR-0003](./adr/0003-hierarchy-adjacency-plus-closure.md)

## Auth — server-side sessions (decided)

**Decided ([ADR-0014](./adr/0014-session-auth-and-revocation.md)):** authentication is a
**server-side session** — an opaque, httpOnly, SameSite cookie referencing a **killable session
record** in a server store (Postgres/Redis). No stateless JWT is the session of record, so
revocation is a single server-side delete effective on the next check, with no token-expiry lag.
Presence/awareness and permission checks layer on top of Yjs — we own that logic (accepted cost
of choosing Yjs over a hosted realtime DB). → [02-tech-stack](./tech-stack.md)

The identity model that "server-side sessions" fills in (all pinned in [ADR-0014](./adr/0014-session-auth-and-revocation.md)):

- **Identity & membership** — the user record and workspace membership are authoritative
  relational data (not in Yjs); invitation, owner-vs-member assignment, and removal are
  first-class API operations required for the collaboration journey. → [product-overview](./product-overview.md)
- **Revocation** — removing a member (or killing a session) in one operation invalidates the
  session record (fails the next REST request and WS check), **drops the live WS connection**
  (Hocuspocus re-resolves the session on a heartbeat/reconnect and disconnects a session that no
  longer maps to a current member), and **stops future presigns** (issuance checks live
  membership). Already-issued short-TTL presigns expire on their own.
- **WebSocket credential** — the client presents its session (cookie / a short-lived WS ticket
  derived from it) to Hocuspocus `onAuthenticate`; **on reconnect the session is re-resolved
  from scratch**, so an offline client revoked while disconnected is rejected on reconnect.
- **CSRF** protection is required on the REST edge (cookie auth); **rate-limiting** on login,
  presign, and WS-connect (see open questions below).
- **Offline access loss.** A client that edited offline and *then* lost access has its queued
  Yjs updates and mutation-outbox writes **rejected server-side on reconnect** — the reconnect
  re-auth ([ADR-0014](./adr/0014-session-auth-and-revocation.md)) plus the write-authz gate
  above are the enforcement point. Locally cached content is best-effort purged on next failed
  auth, but the security boundary is the **server rejecting the replay**, not the client
  deleting its cache. → [07-offline-and-pwa](./offline-and-pwa.md)

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

- Whether awareness/presence leaks any content to unauthorized viewers (audit the Yjs
  awareness payload).
- Rate-limiting and abuse controls on the login, presign, and WS-connect endpoints.
- Session store choice (Postgres table vs. Redis) for the multi-node self-host case —
  a deployment detail, not a model change. → [self-hosting.md](./self-hosting.md)
