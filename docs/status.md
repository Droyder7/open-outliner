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
| `FND` | Repository and engineering foundation | V1 | Ready | Establish the workspace, package manager, TypeScript configuration, quality checks, and developer commands. |
| `DOM` | Shared domain model and item commands | V1 | Needs decision | Resolve which item metadata belongs to Yjs versus the API in [API and Write Path](./api-and-write-path.md#open-questions-resolve-during-build). |
| `ORD` | Fractional ordering and move semantics | V1 | Needs decision | Reconcile fractional ranks with the “CRDT list order” language in [Sync and Conflict Resolution](./sync-and-conflict-resolution.md) and [Roadmap](./roadmap.md). |
| `WEB` | PWA shell and outliner interface | V1 | Ready | Implement the React/Vite app shell and core interactions from [Product Overview](./product-overview.md#core-features-v1-scope). |
| `COL` | Yjs and Hocuspocus collaboration | V1 | Needs decision | Define the exact Yjs document schema, deterministic move clock, cycle normalization, persistence, and compaction behavior. |
| `OFF` | Offline storage, queues, and service worker | V1 | Ready | Implement the local stores and reconnect flows specified in [Offline and PWA](./offline-and-pwa.md). |
| `API` | API and non-CRDT write path | V1 | Needs decision | Choose REST or RPC and settle metadata ownership and subtree-loading defaults in [API and Write Path](./api-and-write-path.md#open-questions-resolve-during-build). |
| `MAT` | Yjs-to-PostgreSQL materializer | V1 | Needs decision | Resolve snapshot storage and descendant tombstoning in [Yjs Projection](./yjs-projection.md#open-implementation-questions-to-resolve-during-build). |
| `DB` | PostgreSQL schema, migrations, and queries | V1 | Needs decision | Move canonical DDL into the decided documentation and remove the split authority described in [Data Model](./data-model.md). |
| `SEC` | Authentication, authorization, and tenancy | V1 | Needs decision | Decide the authentication mechanism and exact V1 permission granularity in [Security and Multi-Tenancy](./security-and-multitenancy.md#open-questions-resolve-during-build). |
| `ATT` | Offline attachments and S3/MinIO storage | V1 basic | Needs decision | Reconcile stable attachment-ID references with the documented switch to `s3_key` in [Attachments and Images](./attachments.md#offline-capture--deferred-upload). |
| `GC` | Tombstones, undo, retention, and hard-delete worker | V1 | Needs decision | Choose eager or lazy descendant tombstoning and define replica acknowledgement and retention rules. |
| `SEA-LOCAL` | Offline search over locally cached items | V1 | Needs decision | Confirm V1 scope and select the local indexing strategy described in [Full-Text Search](./search.md#offline--client-side-search). |
| `SEA-SERVER` | PostgreSQL full-text search | V2 | Deferred | Specification is recorded in [Full-Text Search](./search.md). |
| `V2` | Mirrors, alternate views, and inherited permissions | V2 | Deferred | Scope is recorded in [Roadmap](./roadmap.md#v2--scale--workflowy-parity). |
| `OPS` | Self-hosting, backups, observability, and recovery | V1 | Needs decision | Specify Docker Compose topology, backup/restore procedure, health checks, and materializer monitoring. |
| `QA` | Automated correctness and performance testing | V1 | Ready | Establish test tooling, then turn the V1 success criteria and ordering checklist into executable tests. |
| `REL` | CI, release, upgrade, and rollback process | V1 | Ready | Add pull-request checks, container builds, release validation, and documented rollback steps. |

## V1 Acceptance Gates

These gates come from [Product Overview](./product-overview.md#success-criteria-for-v1) and
must all be **Verified** before V1 is complete.

| Gate | Stage | Evidence / next step |
|---|---|---|
| A user can work offline for a day and synchronize cleanly | Needs decision | Define and automate the offline/reconnect soak scenario. |
| Two users can concurrently edit without corruption or lost structure | Needs decision | Resolve structural merge semantics, then add deterministic convergence tests. |
| Moving and reordering a 10,000-item outline remains responsive | Ready | Define latency and device/browser thresholds, then add a repeatable benchmark. |
| The complete system self-hosts with Docker Compose, PostgreSQL, and S3/MinIO | Ready | Implement the stack and add a clean-environment smoke test. |
