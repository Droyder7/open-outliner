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
| `DOM` | Shared domain model and item commands | V1 | Ready | Metadata ownership resolved by the plane-ownership table in [yjs-schema.md](./yjs-schema.md#plane-ownership). |
| `ORD` | Fractional ordering and move semantics | V1 | Ready | Resolved: atomic `move` register (parent+rank+HLC) in [ADR-0008](./adr/0008-yjs-document-schema.md)/[ADR-0010](./adr/0010-atomic-move-register.md)/[ADR-0009](./adr/0009-move-clock-hlc.md); torn-move and cycle repair ([ADR-0012](./adr/0012-convergent-cycle-resolution.md)) pinned. Next: deterministic-convergence tests. |
| `WEB` | PWA shell and outliner interface | V1 | Needs decision | App shell is implementable, but core editor interaction semantics (Enter/Tab/Backspace, split/merge, multi-select, copy/paste, collapse, zoom, drag targets, cross-document move, focus/invalid-op behavior) and the accessibility/mobile model are unspecified. Define them in [Product Overview](./product-overview.md#core-features-v1-scope) before building the editor. |
| `COL` | Yjs and Hocuspocus collaboration | V1 | Needs decision | Yjs schema + move clock + tombstone pinned ([ADR-0008](./adr/0008-yjs-document-schema.md)/[ADR-0010](./adr/0010-atomic-move-register.md)/[ADR-0011](./adr/0011-crdt-tombstone.md)). **Blocking:** the Yjs persistence boundary (ack-after-persist, dedup, snapshots/compaction, corruption/replay) is undecided — see [yjs-projection.md](./yjs-projection.md#open-decisions--yjs-persistence-boundary-col-decide-during-build). |
| `OFF` | Offline storage, queues, and service worker | V1 | Needs decision | Reconnect/merge flow specified; **blocking:** local-storage failure behavior (quota, private mode, corruption, SW upgrade, Background-Sync absence) is now specified in [Offline and PWA](./offline-and-pwa.md#when-local-storage-fails-required-behavior) but the "every write MUST succeed" promise needs the offline-access-loss rejection ([SEC](#)) wired in. |
| `API` | API and non-CRDT write path | V1 | Needs decision | Metadata ownership resolved ([yjs-schema.md](./yjs-schema.md#plane-ownership)); remaining decision narrowed to REST-vs-RPC + subtree-load defaults in [API and Write Path](./api-and-write-path.md#open-questions-resolve-during-build). |
| `MAT` | Yjs-to-PostgreSQL materializer | V1 | Ready | Diff target pinned ([yjs-schema.md](./yjs-schema.md)); regression/stall resolved by monotonic `projected_rev` + catch-up sweep ([ADR-0013](./adr/0013-projection-revision-guard.md)). Debounce window remains a tuning knob. |
| `DB` | PostgreSQL schema, migrations, and queries | V1 | Ready | Canonical DDL is [`/migrations/0001_init_v1.sql`](../migrations/0001_init_v1.sql) + [`0002_integrity_v1.sql`](../migrations/0002_integrity_v1.sql) (same-document parent FK, attachments FK, `document_projection`); [Data Model](./data-model.md) points at them as source of truth. |
| `SEC` | Authentication, authorization, and tenancy | V1 | Needs decision | Decide the authentication mechanism, revocation/offline-access-loss path, WS write-authz enforcement, and V1 permission granularity in [Security and Multi-Tenancy](./security-and-multitenancy.md#auth). |
| `ATT` | Offline attachments and S3/MinIO storage | V1 basic | Needs decision | Stable-id-vs-`s3_key` and server-verified finalization resolved in [Attachments](./attachments.md#integrity-dedup-security); remaining: confirm presign policy + GC coordination with item hard-delete. |
| `GC` | Tombstones, undo, retention, and hard-delete worker | V1 | Needs decision | Delete representation resolved (CRDT `deleted` register, [ADR-0011](./adr/0011-crdt-tombstone.md)); remaining: eager-vs-lazy descendant tombstoning and the replica-acknowledgement retention rule ([ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)). |
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
| A user can work offline for a day and synchronize cleanly | Needs decision | Merge semantics resolved ([ADR-0008](./adr/0008-yjs-document-schema.md)–[ADR-0012](./adr/0012-convergent-cycle-resolution.md)); gate is not measurable until the offline/reconnect soak scenario (workload, duration, network profile, expected conflict outcomes) is **defined**, then automated. |
| Two users can concurrently edit without corruption or lost structure | Needs decision | Structural merge semantics resolved (atomic move + HLC + cycle repair); "without corruption" needs a concrete definition (convergence assertions, the A↔B cycle case, torn-move absence) before it is a testable gate. |
| Moving and reordering a 10,000-item outline remains responsive | Needs decision | "Responsive" is undefined: set latency thresholds, device/browser matrix, and the exact operation mix, then add a repeatable benchmark. Criteria must exist before this can be Ready. |
| The complete system self-hosts with Docker Compose, PostgreSQL, and S3/MinIO | Needs decision | Depends on `OPS`, which is itself Needs decision (Compose topology, backup/restore ordering across authoritative planes, health checks, materializer monitoring). Define those, then add a clean-environment smoke test. |
| Core editor interaction semantics are defined and behave correctly | Needs decision | New gate (`WEB`): Enter/Tab/Backspace, split/merge, multi-select, copy/paste, collapse, zoom, drag, cross-document move, focus/invalid-op are core product semantics and currently unspecified. Define in [Product Overview](./product-overview.md), then test. |
| Collaboration journey and sharing are complete | Needs decision | New gate (`SEC`/`COL`): invitations, member removal, ownership transfer, viewer capabilities, presence payload/staleness, conflict notifications, sharing privacy are unspecified. → [Security and Multi-Tenancy](./security-and-multitenancy.md). |
| Export has a defined, tested contract | Needs decision | New gate: format, hierarchy/rich-text fidelity, attachment + deleted-content policy, deterministic ordering, and a round-trip acceptance test are undefined. "Own your data" depends on this. |
| Accessibility and mobile interaction meet a stated bar | Needs decision | New gate (`WEB`): no WCAG target, semantic-tree pattern, screen-reader behavior, touch alternative to drag, mobile-keyboard/focus model, or device/browser matrix exists. Set the bar, then verify. |
