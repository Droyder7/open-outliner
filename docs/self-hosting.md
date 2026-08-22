# 14 — Self-Hosting & Operations

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-22

How Open-Outliner runs when someone self-hosts it, and the operational contract behind the
"own your data" principle. This is the `OPS` subsystem: Compose topology, backup/restore,
health checks, and the background jobs (materializer, GC, compaction) the system depends on.

## Topology — single `docker compose` (decided)

V1 self-hosts from **one `docker-compose.yml`** with four services — deliberately a "small
service fleet," consistent with the developer profile and the "ship the outliner before the
platform" bar:

| Service | Role |
|---------|------|
| **web** | The React/Vite PWA static bundle (served by a small static server / the API service). |
| **app** | The Node service hosting **both** the REST `/rpc` API ([api-and-write-path.md](./api-and-write-path.md)) **and** the Hocuspocus WebSocket server + materializer + background jobs. One process for V1; splitting API and Hocuspocus into separate scalable services is a later step, not a V1 requirement. |
| **postgres** | PostgreSQL — `yjs_updates` (CRDT source of truth), the `items` projection, tenancy/membership tables, `attachments` metadata, `document_projection` bookkeeping, and the server-side **session store**. |
| **minio** | S3-compatible blob storage for attachments ([attachments.md](./attachments.md)). Swappable for real S3 in a hosted deployment. |

No hosted-auth or hosted-DB dependency is on the V1 critical path — server-side sessions
([ADR-0014](./adr/0014-session-auth-and-revocation.md)) live in Postgres, so the whole system
is Postgres + MinIO + Node. → [product-overview.md](./product-overview.md) principle #5.

## Background jobs (must run, must be monitored)

The correctness of the system depends on three background jobs, all co-located in **app** for
V1 and all taking the per-document advisory lock (`hashtext(document_id)`) so they can't
interleave for a document:

1. **Materializer** — projects merged CRDT state into `items`, debounced, monotonic on
   `projected_rev`, with a **startup + interval catch-up sweep** ([ADR-0013](./adr/0013-projection-revision-guard.md)).
2. **Yjs compaction** — periodic snapshot + truncate of superseded incremental updates so room
   load stays bounded ([ADR-0015](./adr/0015-yjs-persistence-boundary.md)).
3. **Tombstone-aware GC** — hard-deletes bottom-up after the replica-acknowledgement retention
   window ([ADR-0019](./adr/0019-replica-ack-gc-gating.md): the `replica_sync` ledger, the
   client stateless sync-ack, and the `REPLICA_HEARTBEAT_MS` tick keep `last_synced_at` fresh;
   `GC_RETENTION_MS` is only the wall-clock floor), removes the hard-deleted items' Yjs keys
   under the same gate (via the live room when loaded, else a store delta — so the projection
   cannot re-upsert tombstones), prunes `replica_sync` rows not seen for
   `REPLICA_STALE_TTL_MS` (default 14 days — see the GC-backlog note below), caps never-acked
   rows at `REPLICA_NEVER_ACKED_CAP` per document (default 64 — bounds ledger bloat from
   replica-id cycling), and removes
   attachment S3 objects after their retention
   ([ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md), [attachments.md](./attachments.md)).

## Backup & restore — all authoritative planes together (decided)

The recovery posture ([security-and-multitenancy.md](./security-and-multitenancy.md),
[yjs-projection.md](./yjs-projection.md)) is that the `items` projection is a **rebuildable
cache**, but several planes are **authoritative and NOT rebuildable from Yjs**. A coherent
backup captures them **together**:

| Plane | Backup | Rebuildable? |
|-------|--------|--------------|
| `yjs_updates` (+ snapshots) | `pg_dump` | **No** — CRDT source of truth. Back up hardest. |
| tenancy/membership (`workspaces`, `documents`, `document_members`, sessions) | `pg_dump` | **No** — authoritative relational data. |
| `attachments` metadata | `pg_dump` | **No** — pairs with the S3 objects. |
| S3/MinIO objects | bucket mirror (e.g. `mc mirror`) | **No** — the blobs themselves. |
| `items` + `content_text` / `search_tsv` | (skippable) | **Yes** — re-project from `yjs_updates`. |
| `document_projection` (revisions) | (skippable) | **Yes** — reset `projected_rev = 0`, let the sweep re-project. |
| `replica_sync` (sync-ack ledger) | `pg_dump` | **No** — authoritative for the GC retention bound (ADR-0019). Losing it forgets offline replicas, so GC can hard-delete a tombstone an offline replica hasn't synced. Pairs with `yjs_updates`; a whole-DB `pg_dump` covers it. |

**Restore order matters** (FK and rebuild dependencies):

1. Restore **tenancy/membership** tables first (everything scopes under them).
2. Restore **`yjs_updates`** (+ snapshots) and the **`attachments` metadata**.
3. Restore the **S3/MinIO objects**.
4. **Rebuild the `items` projection** from Yjs via the FK-safe upsert-and-GC procedure
   ([yjs-projection.md](./yjs-projection.md#fk-safe-rebuild-procedure)) — never `TRUNCATE`.
5. Let the **catch-up sweep** advance `projected_rev` to `source_rev`.

A Yjs-only restore is **not** a valid backup: it brings back outline structure and text but
orphans it (no tenancy, no membership, no attachment resolution).

## Health checks & monitoring

- **`/health`** — liveness/readiness for the **app** service (process up, Postgres reachable,
  MinIO reachable). Compose/orchestrator uses it for restart and readiness gating.
- **Projection-lag metric** — `source_rev − projected_rev` per document (or its max/percentiles
  across documents) is the **primary materializer health signal**
  ([ADR-0013](./adr/0013-projection-revision-guard.md)). Sustained lag means the projector is
  falling behind or stuck; alert on it.
- **Compaction lag** — updates-since-last-snapshot per document; a growing tail means room-load
  time is drifting up ([ADR-0015](./adr/0015-yjs-persistence-boundary.md)).
- **GC backlog** — count of tombstoned items/attachments past retention not yet hard-deleted.
  **`gcBlockedDocs`** — the number of documents whose GC is currently gated by an unsynced
  replica (`replica_sync.last_synced_at IS NULL OR last_synced_at <= items.deleted_at`). A
  backlog that refuses to shrink, or a `gcBlockedDocs` value that won't drop, means a known
  replica has not synced past the tombstones (ADR-0019); inspect `replica_sync` for the
  blocking rows.
  - **Most cases self-heal:** the GC pass auto-prunes rows for replicas not seen for
    `REPLICA_STALE_TTL_MS` (default 14 days) — this covers a permanently-gone replica and a
    connection whose sync-ack was lost (which would otherwise block GC forever). A returning
    replica re-registers a blocking row and re-gates until it re-acks, so forgetting is safe.
  - **Immediate unblock (operator):** after confirming a replica is truly dead, prune its row
    by hand (`DELETE FROM replica_sync WHERE document_id = … AND replica_id = …`) — a stuck
    GC is the accepted price of the ack bound, not a bug.

## Open questions (resolve during build)

- Exact Compose resource limits, TLS/reverse-proxy termination, and secret management for a
  production self-host.
- Whether to split **app** into separate API and Hocuspocus services (and add a reverse proxy)
  before V1 GA, or defer to V2 scale work — currently deferred.
- Session store placement for a multi-node deployment (Postgres table vs. Redis) —
  see [security-and-multitenancy.md](./security-and-multitenancy.md) open questions.
- Backup scheduling/retention policy and a restore **drill** (a clean-environment smoke test is
  the self-host acceptance gate in [status.md](./status.md)).
