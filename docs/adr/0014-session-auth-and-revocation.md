# ADR-0014 — Session auth, workspace membership, and revocation

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

`security-and-multitenancy.md` pinned the *shape* of the trust boundary — document-scoped
everything, authz at both the REST and WebSocket edges, read-gates-connection /
write-gates-each-update — but left the **identity model itself** as "decide-during-build":
which authentication mechanism, what permission granularity, and (the load-bearing one) how a
removed member loses access they already hold. Those are not transport details; they gate the
whole collaboration surface (`SEC`, `COL`) and the offline-access-loss promise (`OFF`).

Two forces make this non-trivial in an offline-first, multi-device system:

1. **Revocation must reach a live socket.** A member removed from a workspace has an open
   Hocuspocus WebSocket and may hold unexpired S3 presigns. If the credential can outlive the
   membership row, a removed user keeps editing until it expires — a hole the "back up the CRDT
   hardest" posture cannot tolerate, because those edits are *real, acked outline data*.
2. **An offline client can be revoked while disconnected.** It reconnects later carrying queued
   Yjs updates and outbox writes made *after* it lost access. The server — not the client — must
   be the point that rejects that replay.

## Decision

### Permission model — owner + equal workspace members (V1)

- The **workspace is the tenant boundary** (unchanged). Each workspace has **one owner**.
- The owner invites **members**; every member has **equal read-write access to every document**
  in the workspace. There are **no per-document roles** (no viewer/commenter/editor split) in
  V1. Real-time multiplayer is fully supported; sharing granularity is workspace-level.
- Membership is authoritative **relational** data (`document_members` / a workspace-membership
  table), never in Yjs. Invitation, role assignment (owner vs. member), and removal are
  first-class API operations.
- This is deliberately coarse. Per-document roles and permission **inheritance down the tree**
  (closure table) remain the V2 upgrade (ADR-0003) and are not foreclosed by this decision.

### Authentication — server-side sessions

- Users authenticate into a **server-side session**: an opaque, httpOnly, SameSite cookie that
  references a **killable session record** in a server store (Postgres or Redis). The cookie
  carries no authority of its own — it is a pointer the server resolves on every request.
- **No stateless JWT** for the session of record. A JWT's virtue (no server lookup) is exactly
  what makes instant revocation hard; we choose the opposite trade so revocation is a single
  `DELETE session` / `DELETE membership`, effective on the next check with no expiry lag.

### Revocation — one authoritative kill switch

Removing a member (or the owner deleting their sessions) MUST, in one operation:

1. **Invalidate the session record** so the next REST request and the next WS check both fail.
2. **Drop the live WebSocket.** Hocuspocus re-validates the session on a heartbeat / periodic
   re-auth and on any reconnect; a session that no longer resolves to a current member is
   disconnected and its inbound updates rejected (the write-authz gate already specified in
   `security-and-multitenancy.md` is the enforcement point).
3. **Stop future presigns.** Presign issuance checks live membership, so a revoked user cannot
   mint new S3 PUT/GET URLs. Already-issued presigns are short-TTL (ADR pending / attachments
   doc) and expire on their own; we accept that a presign issued seconds before revocation may
   resolve once within its window.

### WebSocket credential flow

- The client presents its session (cookie / a short-lived WS ticket derived from the session)
  to the Hocuspocus **`onAuthenticate`** hook; the hook resolves it to a current member or
  rejects the connection.
- **On reconnect, the session is re-resolved from scratch.** An offline client whose access was
  revoked while disconnected is rejected at `onAuthenticate` on reconnect — its queued Yjs
  updates and mutation-outbox writes never merge server-side. This is the enforcement of the
  `OFF` "offline access loss" contract: the security boundary is the **server rejecting the
  replay**, not the client purging its cache (which is best-effort on next failed auth).

## Consequences

- **Easier / correct:** revocation is instant and authoritative — one server-side delete cuts
  REST, WS, and presign access with no token-expiry lag; the offline-access-loss gate (`OFF`)
  is satisfied by the same reconnect re-auth; the permission model is small enough to ship and
  reason about.
- **Newly required:** a session store with a kill path; a Hocuspocus periodic re-auth /
  heartbeat that can drop a now-invalid live socket (not only gate the initial connect); a
  WS-ticket or cookie-forwarding scheme so the socket sees the session; CSRF protection on the
  REST edge (cookie auth requires it); rate-limiting on login, presign, and WS-connect.
- **Accepted downsides:** server-side sessions require a session lookup per request (a small
  cost we take deliberately for revocability) and a shared session store in a multi-node
  deployment (Redis or a Postgres table — consistent with the single-Compose self-host
  topology); a presign minted immediately before revocation can be used once within its short
  TTL.
- **Deferred, not foreclosed:** per-document roles, commenter capability, and closure-based
  permission inheritance are V2 (ADR-0003). Nothing here blocks adding them.

## Alternatives considered

- **Short-lived JWT + denylist:** scales statelessly but revocation lags by the token lifetime
  unless every request consults a denylist — at which point the statelessness benefit is gone
  and we have a JWT's complexity plus a server lookup. Rejected in favor of plain sessions.
- **Hybrid JWT (stateless REST) + killable WS session:** revocable sockets but leaves REST
  access lagging by token TTL and splits the identity model across two mechanisms. Rejected as
  more surface for no V1 benefit at self-host scale.
- **Per-document roles in V1:** more granular sharing but multiplies the authz matrix
  (per-update role checks, comment-vs-structure write distinction) before the product needs it.
  Deferred to V2 with the closure-table inheritance it naturally pairs with.

## Cross-references

- [security-and-multitenancy.md](../security-and-multitenancy.md) — the authz boundary this fills in.
- [ADR-0004](./0004-crdt-decides-postgres-records.md) — why membership is relational, not CRDT.
- [ADR-0003](./0003-hierarchy-adjacency-plus-closure.md) — the closure table that carries V2 permission inheritance.
- [offline-and-pwa.md](../offline-and-pwa.md) — the offline-access-loss contract this enforces.
- [ADR-0015](./0015-yjs-persistence-boundary.md) — the persistence boundary whose ack path this authenticates.
