# ADR-0019 — Replica-acknowledgement gating for the tombstone-aware GC retention window

**Status:** Accepted · **Date:** 2026-08-16 · **Deciders:** _TBD_

## Context

[ADR-0006](./0006-soft-delete-and-tombstone-gc.md) makes the GC retention window a
**correctness** property, not just cleanup: a tombstone may be hard-deleted only once
**every known replica has synced past it**, or an offline replica could later re-establish a
reference to a physically gone row. ADR-0006 deliberately left the acknowledgement/heartbeat
mechanism as a decide-during-build item under `GC`/`OPS`. A bare wall clock is the tempting
shortcut and is wrong: "old enough by the clock" says nothing about whether an offline
replica has actually seen the tombstone.

This ADR decides the mechanism, and the implementation that realizes it (migration 0005,
`replica-sync-repo.ts`, `replica-heartbeat.ts`, the Hocuspocus hook wiring in `crdt/server.ts`,
and the gate in `jobs/gc.ts`).

## Decision

**GC may hard-delete a tombstone only when every known replica of the document has
acknowledged a sync that took place after the tombstone.** The acknowledgement is recorded in
a durable `replica_sync` ledger; the wall-clock `retentionMs` remains only as the lower-bound
floor.

### 1. Replica identity: the HLC replica id, minted per tab (ADR-0009)

Clients already mint a stable replica id (`oo:replicaId`, ADR-0009) for HLC tie-breaking. The
id is minted once per **tab** (`sessionStorage`: survives a refresh, dies with the tab), not
once per install — two tabs of the same install are two independent replicas, each with its
own HLC clock and its own `replica_sync` row. The client passes it to the Hocuspocus
connection as a URL parameter (`parameters: { replicaId }`); the server reads it from
`requestParameters` in the `connected` hook. No new identity machinery.

Why per-tab: with a shared per-install id, one tab that completed sync could unblock the
shared row while a sibling tab of the same id was still receiving its first state — exactly
the window the gate exists to close. Per-tab identity makes the ledger truthful per editing
context and keeps the HLC's per-replica monotonicity assumption intact for concurrent offline
edits from two tabs (the in-process live-connection gate below remains as defense in depth).

### 2. The `replica_sync` ledger (migration 0005)

Keyed by `(document_id, replica_id)`:

- `last_synced_at` — set **only** when the replica completes a sync with the server. `NULL`
  means "known but has never completed a sync" and **always blocks GC**.
- `last_seen_at` — pure liveness (connect / heartbeat tick / disconnect). It **never**
  unblocks GC; it only bounds how stale a record is.

`last_synced_at` is **monotonic** — the upsert uses `GREATEST(existing, new)` — so a reconnect
can never regress a replica past a tombstone, and a delayed/older ack cannot either.

### 3. Acknowledgement sources

- **Stateless sync-ack (primary).** When the client's `HocuspocusProvider` `synced` becomes
  `true` (initial sync or re-sync after reconnect), the client sends the stateless payload
  `replica.synced` (`REPLICA_SYNCED_PAYLOAD`). The server's `onStateless` hook marks the socket
  synced and persists `last_synced_at` immediately — no waiting for a tick.
- **Connect touch (blocking).** `connected` writes the ledger row right away with
  `synced: false`, i.e. the touch carries `last_synced_at = NULL`. On a first-ever connect this
  inserts a row that blocks GC until the replica acks; on a reconnect the monotonic (`GREATEST`)
  upsert *preserves* the prior `last_synced_at`, which keeps gating every tombstone newer than
  that ack — equally blocking, never weaker. This closes the connect→sync-complete race for a
  replica's first appearance.
- **Heartbeat tick (continuous-liveness bound).** A client that stays connected and idle never
  re-sends the ack (the provider only re-syncs on connect), so without a tick its
  acknowledgement would go stale and block GC forever even though it received every broadcast.
  A periodic job (`REPLICA_HEARTBEAT_MS`, default 15s) refreshes `last_synced_at` for live
  connections whose `synced` flag is set — "continuously live and initial-synced ⇒ synced past
  everything broadcast so far". A connection that has **not** completed its initial sync only
  advances `last_seen_at`.
- **Disconnect touch.** A connection that had completed its initial sync received everything up
  to that moment; on disconnect its `last_synced_at` is refreshed so a fully-synced replica
  doesn't block GC forever after going offline. A never-synced disconnect deliberately leaves
  `last_synced_at = NULL` — the replica may hold pre-tombstone state and must keep blocking.

### 4. The GC gate

A tombstone (`items.deleted_at`) is eligible for hard-delete iff it is older than the
wall-clock floor **and** no row in `replica_sync` has
`last_synced_at IS NULL OR last_synced_at <= items.deleted_at`. Documents with **no known
replicas** are never blocked (nothing can resurrect). The gate is evaluated per candidate
tombstone in the same leaf-selection query, under the existing per-document advisory lock.

### 5. Stale-replica policy: prune after a TTL (bounds growth, auto-heals lost acks)

`replica_sync` rows are never deleted by the application (only via document cascade), so a
permanently-gone replica — or a connection whose `replica.synced` ack was lost (socket died
mid-handoff, `onDisconnect` left `last_synced_at` NULL) — would block its document's GC
**forever**: the safe direction, but unbounded in time and unbounded in ledger size. The GC
worker therefore prunes, before every pass, any row whose `last_seen_at` is older than
`REPLICA_STALE_TTL_MS` (default 14 days — twice the default 7-day retention floor). Because
`last_seen_at` advances on every connect / heartbeat tick / disconnect / ack, a row that
survives the TTL is a replica that has genuinely not been heard from for the whole window.

Forgetting is **not** the end of the ack bound, because the bound re-forms on reconnection:
a replica that returns re-registers in the `connected` hook — and because the upsert is
monotonic, its **prior** `last_synced_at` survives the reconnect, so every tombstone newer
than that ack keeps blocking GC until the replica syncs and re-acks. A first-ever (or
post-forgetting) connect inserts `last_synced_at = NULL` and gates until the first ack.
The tombstone key deletions GC authored while it was away are durable updates, so the
returning replica converges through normal sync. The accepted edge is narrow and deliberate:
a replica absent **longer than the TTL** loses the gate's protection for tombstones GC
removes during its absence (its reconnection re-gates everything GC does afterward). This
refines the "prune on disconnect" alternative below — disconnect still refreshes-or-blocks
and never forgets; the TTL forgets only after a long, deliberate absence.

## Consequences

- **ADR-0006's correctness property is now enforced in code.** The retention window is an
  acknowledgement bound; `GC_RETENTION_MS` is only the minimum age floor.
- **Newly required:** migration 0005; the client ack (`session.ts`) and `replicaId` parameter;
  the server heartbeat job; the hook wiring in `crdt/server.ts`; the gate in `jobs/gc.ts`.
  Config knobs: `REPLICA_HEARTBEAT_MS` (default 15 000 — faster than the 60s GC interval so a
  fully-synced idle client unblocks GC within one tick), `REPLICA_STALE_TTL_MS` (default
  14 days — the stale-replica pruning TTL, section 5), and `REPLICA_NEVER_ACKED_CAP`
  (default 64 — the per-document cap on never-acked rows).
- **OPS: `replica_sync` is authoritative for the GC bound and is NOT rebuildable from Yjs.**
  Losing the ledger forgets offline replicas, which makes GC *appear* unblocked and can
  hard-delete a tombstone an offline replica hasn't synced — the exact failure ADR-0006
  forbids. Back it up with `yjs_updates` and tenancy (a whole-DB `pg_dump` covers it); a
  partial/DIY backup that omits it weakens the guarantee.
- **OPS escape hatch:** a replica that is permanently gone (never reconnects) blocks GC for
  its document **by design** until the stale-replica TTL forgets it (section 5; `last_seen_at`
  stops advancing the moment it disconnects, so the default 14-day TTL auto-prunes it). An
  operator who needs to unblock sooner — or who wants to keep the guarantee for a replica
  expected to return — prunes the row deliberately
  (`DELETE FROM replica_sync WHERE document_id = … AND replica_id = …`). See self-hosting.md.
- **OPS visibility:** `/health` exposes `gcBlockedDocs` — the number of documents with a
  tombstone currently gated by an unsynced replica — so a stuck ledger is observable (and
  attributable to `replica_sync`) before it matters.
- **Accepted downsides:** a client can connect with a `replicaId` and never sync; while it
  stays seen (`last_seen_at` fresh — the heartbeat keeps it fresh while connected) it blocks
  GC, and after the TTL it is forgotten (section 5). The parameter is untrusted, so it is
  accepted only as a well-formed UUID (anything else is treated as a legacy client and never
  written to the ledger), and never-acked rows are capped per document
  (`REPLICA_NEVER_ACKED_CAP`, default 64 — kept freshest-first, so a genuine mid-first-sync
  client always survives the cap) to bound ledger bloat from replica-id cycling.
  `last_synced_at` is a boolean-ish "synced
  past now" bound, not a precise version vector — sufficient because the server only needs
  "synced past the tombstone", and acked updates are durable (ADR-0015), so "synced" is
  meaningful.
- **Key removal is implemented (ADR-0006's "removing both").** GC hard-delete removes the
  item's Yjs key under this same gate — a transaction on the **live Hocuspocus room** when one
  is loaded (Hocuspocus broadcasts the deletion to connected clients) whose delta is persisted
  to the store **directly and immediately** (not deferred to the Database extension's
  debounced `onStoreDocument`, which would leave a crash window where the rows are already
  deleted but the key deletions are not yet durable), else a **store delta** (`gc-keys.ts`)
  that rides normal Yjs sync to reconnecting replicas. Without key removal the next projection
  pass re-upserts the tombstone ("hard-delete doesn't stick"); with it, the row deletion is
  stable and deleted items are actually purged from the CRDT plane.
- **Residual race (largely closed).** Hocuspocus does **not** guarantee that the
  `connected` hook's ledger write lands before the socket's initial sync is served: the
  framework flushes the queued sync messages and invokes `connected` unawaited. What the
  implementation actually relies on: the hook registers the socket in the in-process registry
  synchronously (its first statement, before any `await`), and GC skips a document while **any
  live connection** for it has not completed its initial sync. A GC pass that reads
  `replica_sync` in the milliseconds before a reconnecting replica's connect touch commits is
  still gated by that replica's **persisted** row from its previous session (stale acks block
  newer tombstones). The only uncovered case is a replica's first-ever connect racing a pass —
  such a replica holds no pre-tombstone state, so it receives the post-deletion state and
  converges; a returning replica whose row was pruned by the TTL is the accepted edge of
  section 5. Replica ids are per-tab (section 1), so a synced tab can never unblock a sibling
  tab sharing its id — the in-process gate remains as defense in depth for any legacy/shared-id
  client. A multi-node deployment would need a shared registry or equivalent distributed
  signal; V1 is single-process, and even then the row deletion is rebuildable from Yjs
  (ADR-0004).

## Alternatives considered

- **Bare wall clock (pre-ADR status quo):** violates ADR-0006's explicit requirement; rejected.
- **Precise version/state-vector ack (client echoes its Yjs state vector):** more exact, but
  requires wire-protocol changes and per-update bookkeeping. The stateless boolean ack plus the
  heartbeat/disconnect bounds gives the same guarantee for the one decision GC makes ("has this
  replica synced past this tombstone?"). Rejected for V1 simplicity.
- **Awareness-based ack:** awareness is ephemeral and not durable; it cannot drive a persisted
  ledger that must survive process restarts. Rejected.
- **Prune replica rows on disconnect:** would forget a replica that is offline-but-alive,
  destroying the guarantee. Rejected — disconnects refresh or block, never forget. The
  **stale-replica TTL** (section 5) is the deliberate middle ground: forget only after a
  long, configured absence, when reconnection is near-certain to re-form the bound anyway.
- **Gate on the in-process connection registry alone:** closes the connect race only for this
  process and survives no restarts; the durable ledger is required for the offline-replica
  case the guarantee exists for. Rejected.

## Cross-references

- [ADR-0006](./0006-soft-delete-and-tombstone-gc.md) — the requirement this mechanism realizes
  (its "decide-during-build" item is now decided here).
- [ADR-0009](./0009-move-clock-hlc.md) — the replica id reused for the ledger key.
- [ADR-0011](./0011-crdt-tombstone.md) — what a tombstone is and why it must converge first.
- [ADR-0015](./0015-yjs-persistence-boundary.md) — acked updates are durable, which makes the
  ack meaningful.
- [`migrations/0005_replica_sync_v1.sql`](../../migrations/0005_replica_sync_v1.sql),
  [`packages/server/src/db/replica-sync-repo.ts`](../../packages/server/src/db/replica-sync-repo.ts),
  [`packages/server/src/crdt/replica-heartbeat.ts`](../../packages/server/src/crdt/replica-heartbeat.ts),
  [`packages/server/src/crdt/gc-keys.ts`](../../packages/server/src/crdt/gc-keys.ts),
  [`packages/server/src/crdt/server.ts`](../../packages/server/src/crdt/server.ts),
  [`packages/server/src/jobs/gc.ts`](../../packages/server/src/jobs/gc.ts),
  [`packages/client/src/session.ts`](../../packages/client/src/session.ts),
  [`packages/client/src/replica-id.ts`](../../packages/client/src/replica-id.ts).
