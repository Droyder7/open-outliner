# Plan — Sequenced V1 Implementation Build Order

## Context

Every V1 subsystem in `docs/status.md` is now **Ready** (specs + ADRs 0001–0017 pinned), but **no application code exists** — the repo holds only `docs/`, `migrations/`, and `AGENTS.md`. This plan turns the Ready specs into a dependency-ordered construction sequence: what to scaffold first, what each phase depends on, and the gate that proves each phase before the next starts.

Two decisions shape the sequence (confirmed with the user):
- **pnpm monorepo** with a `shared` package so the Yjs schema, HLC, fractional-index, and command contracts are authored **once** and imported by both client and server — the drift the atomic-move/HLC ADRs are sensitive to is eliminated structurally.
- **Vertical slice first** — build the hardest integration (the CRDT→Postgres projection spine) end-to-end early, then widen. Nothing is "done in isolation" before it runs through the real seam.

`AGENTS.md` rules bind: read `docs/status.md` before each subsystem, and **advance its status row in the same change** (Ready → In progress → Implemented → Verified, with a code/test Evidence link — never on intention). Accepted ADRs are immutable — supersede, never edit.

## Repository scaffold (Phase 0 output)

```
open-outliner/
├─ package.json            # pnpm workspace root, shared scripts
├─ pnpm-workspace.yaml
├─ tsconfig.base.json      # strict TS, shared compiler options
├─ docker-compose.yml      # postgres + minio first; web + app added in Phase 12
├─ migrations/             # EXISTS: 0001, 0002 — schema of record
└─ packages/
   ├─ shared/    # Yjs schema, HLC, fractional-index, tombstone/move registers,
   │             #   RPC command + error types. Pure TS, zero I/O, unit-tested.
   ├─ server/    # Node: Hocuspocus + persistence adapter, materializer,
   │             #   /rpc API, auth/sessions, background jobs. Imports shared.
   └─ client/    # Vite React PWA: direct Y.Text binding, y-indexeddb,
                 #   Hocuspocus provider, editor keymap. Imports shared.
```

## Dependency graph (what blocks what)

```
FND (scaffold)
  └─> shared (DOM, ORD, command types)
        ├─> DB (migrations + runner + 0003 reconcile)
        │     └─> COL+MAT  ── the CRDT→projection spine ──┐
        │                                                 │
        └─> client editor binding (WEB) ──────────────────┤ = VERTICAL SLICE
                                                          ▼
                                          SEC ─> API ─> OFF ─> ATT ─> GC
                                                                       └─> EXPORT ─> SEA ─> OPS ─> QA/REL
```

The **vertical slice** (FND → shared → DB → COL+MAT + minimal WEB) is the critical path. Everything after widens outward from a system that already round-trips a bullet.

## Phased sequence

### Phase 0 — Foundation (`FND`)
Scaffold the pnpm workspace, `tsconfig.base.json` (strict), the three empty packages, lint/format/test tooling (ESLint + Prettier + Vitest), and root dev scripts. Add `docker-compose.yml` with **postgres + minio only** so DB work has a target.
**Gate:** `pnpm install && pnpm -r typecheck` green on empty packages; compose brings up Postgres + MinIO.

### Phase 1 — Shared contracts (`DOM`, `ORD`) — *no I/O, all unit-testable*
In `packages/shared`, author the load-bearing pure logic both sides import:
- Yjs document schema / plane-ownership (ADR-0008, `yjs-schema.md`).
- HLC `{wallMs, counter, replicaId}` compare/tick (ADR-0009).
- Atomic `move` register (parent+rank+hlc, one nested Y.Map value) (ADR-0010).
- `deleted` tombstone register (ADR-0011).
- Fractional index generate-between, `COLLATE "C"` byte-order rules (ADR-0005).
- RPC command + error envelope types (the `/rpc` contract skeleton).
**Gate:** unit tests for HLC ordering, fractional-index between/collision, and move-register atomicity pass. This is where convergence correctness is cheapest to prove.

### Phase 2 — Database layer (`DB`)
Add a migration runner. Migrations `0001`+`0002` already exist and are the schema of record. Add **`0003_sessions_and_membership_v1.sql`** to reconcile the spec with ADR-0014: replace the stale `document_members.role` CHECK (`owner/editor/commenter/viewer`) with the **owner + equal-members** model, and add the server-side **session store** table. Postgres connection pool + typed query layer.
**Gate:** runner applies 0001→0003 clean on the compose Postgres; schema matches `data-model.md` invariants.

### Phase 3 — CRDT persistence spine (`COL` + `MAT`) — *core of the vertical slice*
- Hocuspocus server with an **ack-after-persist** store adapter writing incremental updates to `yjs_updates`, replay-tolerant, never acking before durable (ADR-0015).
- Materializer: project merged CRDT state → `items` via FK-safe upsert-and-GC, **monotonic `projected_rev`** guard + startup/interval **catch-up sweep** (ADR-0013, `yjs-projection.md`).
- Deterministic **cycle repair** on projection (youngest edge loses → root) (ADR-0012).
**Gate (spine proof):** a headless Yjs client edits a doc → update lands in `yjs_updates` → materializer writes rows to `items` → read back reflects structure + order. Concurrent two-client merge converges with no torn move and no cycle.

### Phase 4 — Client shell + editor (`WEB`) — *closes the slice through the UI*
- Vite React PWA shell; direct `Y.Text` binding to Yjs (TipTap dropped, [ADR-0018](./docs/adr/0018-plain-text-content-v1.md)); `y-indexeddb` local persistence; Hocuspocus provider to the Phase 3 server.
- **First:** plain bullet typing — completes the end-to-end slice through a real browser (type → Yjs → persist → materialize → reload).
- **Then:** Workflowy-parity keymap (ADR-0017) — Enter split, Tab/Shift-Tab indent/outdent, Backspace merge, Cmd/Ctrl-↑↓ move, collapse/expand (`isCollapsed` LWW), zoom (client-side), multi-select over flattened visible order, copy/paste (internal structured + external Markdown), drag with cycle-safe drop validity, cross-document move = cut-and-reinsert, uniform invalid-op = no-op. **Every structural change is one atomic `move` transaction.** The synthetic root register is not user-mutable.
**Gate:** the vertical slice is a usable single-user outliner in the browser; keymap operations behave per ADR-0017.

### Phase 5 — Auth, sessions & revocation (`SEC`)
Server-side opaque httpOnly-cookie sessions backed by the Phase 2 session store; owner invites equal members; Hocuspocus `onAuthenticate` resolves the session; **revocation** invalidates the session, drops the live WS, and stops future presigns; reconnect re-resolves (ADR-0014). Wraps the spine with the trust boundary before more surface is added.
**Gate:** an unauthenticated/revoked client cannot open a doc WS or replay a queue; removing a member kills their live connection.

### Phase 6 — `/rpc` API (`API`)
Single `/rpc` endpoint dispatching typed commands (queries, auth, presign, settings) using the Phase 1 command/error types; `UpdateItem` metadata may ride the API/projection path with `version` optimistic concurrency; subtree **load-on-expand** (`api-and-write-path.md`).
**Gate:** command round-trips with typed errors; a version conflict is rejected correctly.

### Phase 7 — Offline & PWA (`OFF`)
Service worker via `vite-plugin-pwa`/Workbox; mutation queue; reconnect/merge flow; local-storage-failure behavior; **offline-access-loss rejection wired to the killable session** on reconnect (`offline-and-pwa.md`).
**Gate:** edit offline for a session, reconnect, converge cleanly; a revoked offline client's replay is rejected.

### Phase 8 — Attachments (`ATT`)
`attachments` table exists (migration `0002`). MinIO client; **short presign TTLs** (PUT ~5m / GET ~15m); offline capture + deferred upload; server-verified finalization (stable-id vs `s3_key`, checksum) (`attachments.md`).
**Gate:** capture offline → deferred upload on reconnect → server finalizes → GET presign serves it.

### Phase 9 — Delete & GC (`GC`)
Lazy tombstone: delete sets the `deleted` register on the **subtree root only**; reads/projector filter descendants under any deleted ancestor (ADR-0006, ADR-0011). Tombstone-aware hard-delete worker: bottom-up after the **replica-acknowledgement** retention window (under `hashtext(document_id)` advisory lock), then S3 object removal coordinated with the RESTRICT FK.
**Gate:** delete + undo cheap; hard-delete only after retention; no FK violation, no orphaned S3 object.

### Phase 10 — Export (`EXPORT` / gate)
Markdown (lossy, human-readable) + JSON (full-fidelity round-trip); deterministic `(rank, id)` order; tombstones excluded; attachments referenced by id (ADR-0016).
**Gate:** the **round-trip acceptance test** (export → import → structural/text equivalence) passes — the Export gate's path to Verified.

### Phase 11 — Offline search (`SEA-LOCAL`)
Naive in-memory substring/filter over loaded items; no built index (server FTS is V2) (`search.md`).
**Gate:** filter matches expected items over the loaded working set.

### Phase 12 — Compaction & self-hosting (`OPS`)
Yjs **compaction** job (`encodeStateAsUpdate` + truncate superseded, under advisory lock) (ADR-0015). `/health`; projection-lag / compaction-lag / GC-backlog metrics. Complete `docker-compose.yml` (**web + app** added to postgres + minio); backup all authoritative planes; documented restore order tenancy → Yjs/attachments → S3 → projection rebuild (`self-hosting.md`).
**Gate:** clean-environment **smoke test** — bring up Compose, create/edit/sync, back up, restore-drill — passes. The self-host acceptance gate.

### Phase 13 — Acceptance harness, CI & release (`QA`, `REL`)
Define the four still-open **measurable** gate thresholds (offline-soak workload/duration/network profile; concurrent-edit convergence assertions incl. A↔B cycle + torn-move absence; 10k-item move/reorder latency + device matrix; self-host smoke) and automate them. Add PR checks, container builds, release validation, documented rollback.
**Gate:** the V1 acceptance gates in `status.md` move Needs-decision → Verified.

## Status.md maintenance (per `AGENTS.md`)

Each phase advances its subsystem rows in the **same change**: `Ready → In progress` when work starts, `→ Implemented` when built, `→ Verified` when the phase gate's automated checks pass, always with an Evidence link. The four measurability gates reach Verified only in Phase 13.

## Out of scope (V1)
- V2 items: closure/`ltree` accelerator, `item_refs` mirrors/transclusion, server-side Postgres FTS, per-document roles, inherited permissions.
- Post-V1 deferred: accessibility/WCAG + touch-drag (recorded decision, `product-overview.md` principle #4 / ADR-0017), splitting app into separate API + Hocuspocus services.

## Verification (how each phase is proven)
Each phase has a concrete **gate** above; the overarching checks:
1. **Vertical-slice proof (end of Phase 4):** a bullet typed in the browser survives Yjs → `yjs_updates` → materializer → `items` → reload, and two clients converge without torn move or cycle.
2. **Per-subsystem gates** run as automated tests as each phase lands (unit for shared logic; integration for the spine, auth, offline, attachments, GC, export; e2e for the editor).
3. **Self-host smoke test (Phase 12)** on a clean environment.
4. **status.md consistency:** no subsystem row advances without a code/test Evidence link; acceptance gates reach Verified only when their harness passes (Phase 13).
