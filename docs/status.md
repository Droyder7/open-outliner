# Development Status

This file is the source of truth for the current development state of Open-Outliner.
It tracks implementation at the subsystem level without duplicating detailed specifications
or becoming a task backlog.

- [`roadmap.md`](./roadmap.md) defines release scope.
- The numbered topic documents define required behavior.
- [`adr/`](./adr/) records architectural decisions.
- This file records whether each part is ready, implemented, and verified.

## Stages

Use exactly one of these stages for each row:

| Stage | Meaning |
|---|---|
| **Needs decision** | A requirement is missing, contradictory, or too unclear to implement safely. |
| **Ready** | The part is sufficiently specified and can be implemented without a blocking product or architecture decision. |
| **In progress** | Implementation has started but is not complete. |
| **Implemented** | The required implementation exists, but its acceptance checks have not all passed. |
| **Verified** | The implementation exists and its relevant automated tests or documented acceptance checks pass. This is the only completed stage. |
| **Deferred** | The part is explicitly outside the current release scope. |

## How To Maintain This File

1. Update a row in the same commit as the work that changes its stage.
2. Do not advance a stage based on intention. Add a link to code, tests, a validation record,
   or another concrete artifact in **Evidence / next step**.
3. If a part is blocked by an unresolved choice, use **Needs decision** and name the one next
   decision required. Record significant decisions in an ADR or the relevant topic document.
4. Use **Implemented** until all acceptance checks pass. Only **Verified** means complete.
5. Keep this table at subsystem level. Do not add rows for individual files, commits, or small
   tasks.
6. Split a row into stable child IDs such as `SYNC-01` and `SYNC-02` only when work begins and
   the children genuinely have different stages. Do not renumber existing IDs.
7. When splitting a row, keep the parent as a summary and derive its stage from its required
   children. A parent cannot be **Verified** until every required child is **Verified**.
8. Do not add percentages. Report progress by stage and by release-critical acceptance gates.
9. Do not delete historical IDs. Mark removed work **Deferred** and explain the scope change.
10. Review all V1 rows before a release and whenever `roadmap.md` changes.

## Current Status

The repository currently contains product and architecture specifications but no application
implementation. An accepted design document is evidence of specification, not evidence that
the corresponding subsystem has been implemented.

| ID | Part | Scope | Stage | Evidence / next step |
|---|---|---|---|---|
| `FND` | Repository and engineering foundation | V1 | Implemented | pnpm workspace + strict `tsconfig.base.json` + three packages (`shared`/`server`/`client`) + ESLint/Prettier/Vitest + `docker-compose.yml` (postgres+minio). Gate met: `pnpm install && pnpm -r typecheck` green, lint + test wired ([package.json](../package.json), [pnpm-workspace.yaml](../pnpm-workspace.yaml), [docker-compose.yml](../docker-compose.yml)). Verified pending Compose bring-up in a Docker-capable env. |
| `DOM` | Shared domain model and item commands | V1 | Implemented | `packages/shared` authors the plane-ownership contract once: Yjs schema constants + `ItemNodeSnapshot` ([yjs-schema.ts](../packages/shared/src/yjs-schema.ts)), HLC ([hlc.ts](../packages/shared/src/hlc.ts)), pure structural-command builders ([item-commands.ts](../packages/shared/src/item-commands.ts)), and `/rpc` command/error envelope types ([rpc.ts](../packages/shared/src/rpc.ts)). Gate met: 44 unit tests green. Verified pending consumption by server/client (Phases 3–4). |
| `ORD` | Fractional ordering and move semantics | V1 | Implemented | Atomic `move` register + HLC total order + fractional index (COLLATE "C") authored in `packages/shared`; midpoint engine is the production-proven `fractional-indexing` (ASCII/base-62 = byte order) with ADR-0005 jitter/`openSpace` layered on ([fractional-index.ts](../packages/shared/src/fractional-index.ts), [ordering.ts](../packages/shared/src/ordering.ts)). Deterministic cycle repair ([cycle.ts](../packages/shared/src/cycle.ts), ADR-0012). Gate met: HLC-ordering, between/collision, move-atomicity, and A↔B-swap convergence tests pass. |
| `WEB` | PWA shell and outliner interface | V1 | Implemented | Vite React PWA shell binds the outliner to the live Y.Doc: `y-indexeddb` local persistence (offline-first) + an opt-in Hocuspocus provider ([session.ts](../packages/client/src/session.ts)). Content binds **directly to each item's `Y.Text`**, plain text only, TipTap dropped ([RowText.tsx](../packages/client/src/RowText.tsx), [ADR-0018](./adr/0018-plain-text-content-v1.md)); a minimal prefix/suffix diff keeps concurrent edits merge-friendly. ADR-0017 keymap wired to the shared structural commands ([Outliner.tsx](../packages/client/src/Outliner.tsx)): Enter split, Tab/Shift-Tab indent/outdent, Backspace delete/merge, Delete-at-end merge, Cmd/Ctrl-↑↓ move, Cmd/Ctrl-Enter complete, Cmd/Ctrl-. collapse, caret nav over flattened visible order, collapse/expand + client-side zoom with breadcrumb. Every structural change is one atomic `move` write; split/merge/parent lookups live in shared `@open-outliner/crdt` ([outline.ts](../packages/crdt/src/outline.ts)). Gate met: `pnpm -r typecheck` + `pnpm lint` green, client `vite build` succeeds, 19 crdt outline/keymap unit tests pass. Remaining before Verified: browser e2e of the keymap + full server round-trip (needs the WS listen bootstrap + Phase 5 auth); multi-select, drag, and Markdown copy/paste deferred (paste aligns with export, Phase 10). Accessibility & touch-drag deferred post-V1 (see [Product Overview](./product-overview.md) principle #4). Rich-text marks deferred to V2 ([ADR-0018](./adr/0018-plain-text-content-v1.md)). |
| `COL` | Yjs and Hocuspocus collaboration | V1 | Implemented | Hocuspocus server wired to an ack-after-persist store adapter ([server.ts](../packages/server/src/crdt/server.ts), [yjs-store.ts](../packages/server/src/crdt/yjs-store.ts)): durable commit to `yjs_updates` before ack, replay-tolerant load with corrupt-row skip (ADR-0015). Compaction job deferred to Phase 12 (OPS) per the build-order plan. Gate met: headless two-client concurrent-edit test converges with no torn move. Remaining: snapshot/compaction, `onAuthenticate` (Phase 5). |
| `MAT` | Yjs-to-PostgreSQL materializer | V1 | Implemented | Materializer projects merged CRDT snapshots to `items` via FK-safe topological upsert, monotonic `projected_rev` guard, and a catch-up sweep ([projector.ts](../packages/server/src/crdt/projector.ts), [materialize.ts](../packages/server/src/crdt/materialize.ts), ADR-0013). Cycle detection/repair emits an ordinary `move` write and re-projects — never vetoes (ADR-0012); resolved that "reparent to root" means becoming a child of the document's one root item, not the sentinel itself (`items_one_root_per_doc_idx`). Lazy tombstone filtering (ADR-0006/0011). Gate met: spine proof + A↔B cycle convergence + monotonic-guard + catch-up-sweep tests pass against real Postgres. |
| `OFF` | Offline storage, queues, and service worker | V1 | Ready | Reconnect/merge flow + local-storage failure behavior specified ([Offline and PWA](./offline-and-pwa.md#when-local-storage-fails-required-behavior)); offline-access-loss rejection wired to the killable server session on reconnect ([ADR-0014](./adr/0014-session-auth-and-revocation.md)). |
| `API` | API and non-CRDT write path | V1 | Ready | Shape decided: **single `/rpc`** endpoint, `UpdateItem` metadata may ride API/projection with `version`, subtree load-on-expand ([API and Write Path](./api-and-write-path.md#api-shape--single-rpc-endpoint-decided)). Remaining: exact command schema/error envelope (build-time). |
| `MAT` | Yjs-to-PostgreSQL materializer | V1 | Ready | Diff target pinned ([yjs-schema.md](./yjs-schema.md)); regression/stall resolved by monotonic `projected_rev` + catch-up sweep ([ADR-0013](./adr/0013-projection-revision-guard.md)). Debounce window remains a tuning knob. |
| `DB` | PostgreSQL schema, migrations, and queries | V1 | Implemented | Canonical DDL is [`0001`](../migrations/0001_init_v1.sql)+[`0002`](../migrations/0002_integrity_v1.sql)+[`0003_sessions_and_membership_v1.sql`](../migrations/0003_sessions_and_membership_v1.sql) (adds `users`, workspace membership with one-owner index, reconciles `document_members.role` to owner/member, killable `sessions` store — ADR-0014). Forward-only migration runner + typed pool/query layer + repos ([packages/server/src/db](../packages/server/src/db)). Gate met: runner applies 0001→0003 clean on Postgres 16; schema invariants (role CHECK, one-root/one-owner indexes, `rank COLLATE "C"`) verified; 6 integration tests green. |
| `SEC` | Authentication, authorization, and tenancy | V1 | Ready | Decided: **owner + equal workspace members** (no per-doc roles V1), **server-side sessions**, authoritative revocation (kills live WS + future presigns), reconnect re-auth ([ADR-0014](./adr/0014-session-auth-and-revocation.md)). Remaining (build-time): awareness-payload audit, rate-limiting, session-store placement. |
| `ATT` | Offline attachments and S3/MinIO storage | V1 basic | Ready | Stable-id-vs-`s3_key` + server-verified finalization ([Attachments](./attachments.md#integrity-dedup-security)); presign/GC decided — short presign TTLs (PUT ~5m/GET ~15m) + deferred S3 GC coordinated with hard-delete under the RESTRICT FK ([Attachments](./attachments.md#deletion--presign-policy-decided)). |
| `GC` | Tombstones, undo, retention, and hard-delete worker | V1 | Ready | Delete = CRDT `deleted` register ([ADR-0011](./adr/0011-crdt-tombstone.md)); descendant tombstoning decided **lazy** (mark subtree root, filter under deleted ancestor, [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)). Remaining (build-time): the replica-acknowledgement heartbeat that gates hard-delete. |
| `SEA-LOCAL` | Offline search over locally cached items | V1 | Ready | Decided: **naive in-memory filter** over loaded items (no built index); built client index + server FTS are V2 ([Full-Text Search](./search.md#offline--client-side-search)). |
| `SEA-SERVER` | PostgreSQL full-text search | V2 | Deferred | Specification is recorded in [Full-Text Search](./search.md). |
| `V2` | Mirrors, alternate views, and inherited permissions | V2 | Deferred | Scope is recorded in [Roadmap](./roadmap.md#v2--scale--workflowy-parity). |
| `OPS` | Self-hosting, backups, observability, and recovery | V1 | Ready | Decided: **single `docker compose`** (web + app + Postgres + MinIO), backup of all authoritative planes with restore order tenancy → Yjs/attachments → S3 → projection rebuild, `/health` + projection-lag/compaction/GC metrics ([Self-Hosting](./self-hosting.md)). Remaining (build-time): resource limits, TLS, backup scheduling + restore drill. |
| `QA` | Automated correctness and performance testing | V1 | Ready | Establish test tooling, then turn the V1 success criteria and ordering checklist into executable tests. |
| `REL` | CI, release, upgrade, and rollback process | V1 | Ready | Add pull-request checks, container builds, release validation, and documented rollback steps. |

## V1 Acceptance Gates

These gates come from [Product Overview](./product-overview.md#success-criteria-for-v1) and
must all be **Verified** before V1 is complete.

| Gate | Stage | Evidence / next step |
|---|---|---|
| A user can work offline for a day and synchronize cleanly | Needs decision | Merge semantics resolved ([ADR-0008](./adr/0008-yjs-document-schema.md)–[ADR-0012](./adr/0012-convergent-cycle-resolution.md)); gate is not measurable until the offline/reconnect soak scenario (workload, duration, network profile, expected conflict outcomes) is **defined**, then automated. |
| Two users can concurrently edit without corruption or lost structure | Needs decision | Structural merge semantics resolved (atomic move + HLC + cycle repair); "without corruption" needs a concrete definition (convergence assertions, the A↔B cycle case, torn-move absence) before it is a testable gate. |
| Moving and reordering a 10,000-item outline remains responsive | Needs decision | "Responsive" is undefined: set latency thresholds, device/browser matrix, and the exact operation mix, then add a repeatable benchmark. Criteria must exist before this can be Ready. |
| The complete system self-hosts with Docker Compose, PostgreSQL, and S3/MinIO | Needs decision | Topology + backup/restore ordering + health/monitoring now specified ([Self-Hosting](./self-hosting.md), `OPS` Ready). Gate stays Needs decision until a **clean-environment smoke test** (bring up Compose, create/edit/sync, backup, restore-drill) is defined and automated. |
| Core editor interaction semantics are defined and behave correctly | Needs decision | Semantics **defined**: Workflowy-parity ([ADR-0017](./adr/0017-editor-interaction-model.md)) — Enter/Tab/Backspace split/merge, multi-select, copy/paste, collapse, zoom, drag validity, cross-document cut-and-reinsert, invalid-op behavior. "Behave correctly" half stays open until the editor is built and its interaction tests pass. |
| Collaboration journey and sharing are complete | Needs decision | Model decided: **owner + equal workspace members**, server-side sessions, authoritative revocation ([ADR-0014](./adr/0014-session-auth-and-revocation.md)). Gate reaches Verified once invitation/removal/ownership flows + presence-payload audit are implemented and tested. → [Security and Multi-Tenancy](./security-and-multitenancy.md). |
| Export has a defined, tested contract | Needs decision | Contract decided: **Markdown + JSON round-trip**, deterministic `(rank,id)` order, tombstones excluded, attachments referenced ([ADR-0016](./adr/0016-export-contract.md)). Gate reaches Verified when the round-trip acceptance test (export→import equivalence) is implemented and passing. |
| Accessibility and mobile interaction meet a stated bar | Deferred | **Explicitly post-V1** (recorded decision, [Product Overview](./product-overview.md) principle #4). V1 is desktop-keyboard-first ([ADR-0017](./adr/0017-editor-interaction-model.md)); WCAG target, ARIA tree pattern, screen-reader behavior, and a touch alternative to drag are a named post-V1 commitment, not a V1 gate. |
