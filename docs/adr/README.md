# Architecture Decision Records

One file per significant, hard-to-reverse decision, in the standard
**Context / Decision / Consequences** form. ADRs are immutable once Accepted — to change
one, add a new ADR that supersedes it and update the Status line here.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](./0001-web-first-pwa-stack.md) | Web-first PWA + Yjs + Node/Postgres stack (Pattern 1) | Accepted |
| [0002](./0002-sync-engine-yjs-vs-localfirst.md) | Yjs CRDT over a local-first sync engine | Accepted |
| [0003](./0003-hierarchy-adjacency-plus-closure.md) | Adjacency list as truth, closure/ltree as accelerator | Accepted |
| [0004](./0004-crdt-decides-postgres-records.md) | CRDT decides, Postgres records and validates | Accepted |
| [0005](./0005-fractional-indexing-ordering.md) | Fractional indexing for sibling order | Accepted |
| [0006](./0006-soft-delete-and-tombstone-gc.md) | Soft delete + tombstone-aware GC (no cascade) | Accepted |
| [0007](./0007-attachments-off-crdt-plane.md) | Attachments on a separate S3 blob plane | Accepted |
| [0008](./0008-yjs-document-schema.md) | Yjs document schema & order model (LWW rank register) | Accepted |
| [0009](./0009-move-clock-hlc.md) | Move/rank clock: Hybrid Logical Clock (HLC) | Accepted |
| [0010](./0010-atomic-move-register.md) | The move is one atomic register (no torn moves) | Accepted |
| [0011](./0011-crdt-tombstone.md) | Delete is a CRDT register, not a missing key | Accepted |
| [0012](./0012-convergent-cycle-resolution.md) | Convergent cycle resolution | Accepted |
| [0013](./0013-projection-revision-guard.md) | Projection revision guard & catch-up reconciliation | Accepted |
| [0014](./0014-session-auth-and-revocation.md) | Session auth, workspace membership & revocation | Accepted |
| [0015](./0015-yjs-persistence-boundary.md) | Yjs persistence boundary: ack-after-persist, snapshots, compaction | Accepted |
| [0016](./0016-export-contract.md) | Export contract: Markdown + JSON round-trip | Accepted |
| [0017](./0017-editor-interaction-model.md) | Editor interaction model: Workflowy-parity | Accepted |

## Template

```markdown
# ADR-NNNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-XXXX
**Date:** YYYY-MM-DD · **Deciders:** _TBD_

## Context
What forces are at play? What problem/constraints?

## Decision
What we decided, stated plainly.

## Consequences
What becomes easier, harder, or newly required. Include the accepted downsides.

## Alternatives considered
What we rejected and why.
```
