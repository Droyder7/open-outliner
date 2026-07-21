# Open-Outliner — Product & Architecture Documentation

This folder is the **decided** layer of Open-Outliner: an open-source, offline-first,
real-time collaborative outliner in the lineage of Dynalist and Workflowy.

Where [`../idea-research-report.md`](../idea-research-report.md) is the *exploratory*
research (options weighed, trade-offs surveyed), these docs record **what we have
actually chosen** and why. When the two disagree, **these docs win** — the report is a
snapshot of the investigation, not the source of truth.

## How to read this

Start at the top and go down; each doc assumes the ones above it.

| # | Doc | What it decides |
|---|-----|-----------------|
| 00 | [product-overview.md](./product-overview.md) | What we're building, for whom, product principles, scope |
| 01 | [architecture-overview.md](./architecture-overview.md) | The whole system on one page: components, data flow, boundaries |
| 02 | [tech-stack.md](./tech-stack.md) | Chosen frameworks/services and the discarded alternatives |
| 03 | [data-model.md](./data-model.md) | Entities, the hierarchy model, the canonical SQL schema |
| 04 | [sync-and-conflict-resolution.md](./sync-and-conflict-resolution.md) | Offline-first sync, CRDT choice, concurrent-move semantics |
| 05 | [fractional-indexing.md](./fractional-indexing.md) | Sibling ordering: the decided algorithm and its rules |
| 06 | [yjs-projection.md](./yjs-projection.md) | How Yjs state becomes queryable Postgres rows |
| 07 | [offline-and-pwa.md](./offline-and-pwa.md) | Local storage, service worker, mutation queue, attachments offline |
| 08 | [search.md](./search.md) | Full-text search, online (Postgres) and offline (client) |
| 09 | [attachments.md](./attachments.md) | Binary blobs: S3, offline capture, deferred upload |
| 10 | [api-and-write-path.md](./api-and-write-path.md) | The command surface and how writes flow through the system |
| 11 | [security-and-multitenancy.md](./security-and-multitenancy.md) | Tenancy, permissions, authz boundaries |
| 12 | [roadmap.md](./roadmap.md) | V1 / V2 split and what is explicitly deferred |
| 13 | [glossary.md](./glossary.md) | Terms used consistently across all docs |

Architecture Decision Records live in [`./adr/`](./adr/) — one file per irreversible-ish
decision, in the standard Context / Decision / Consequences form. See
[adr/README.md](./adr/README.md) for the index.

Current implementation progress is tracked separately in
[`status.md`](./status.md). It distinguishes accepted design from implemented and verified
software.

## The one-paragraph version

Open-Outliner is a **React/Vite PWA** whose canonical client state is a **Yjs CRDT
document** persisted locally in **IndexedDB** and synced in real time over WebSockets via
**Hocuspocus**. The **Yjs document is the source of truth for structure and text**; a
server-side **materializer** projects it into a **PostgreSQL** relational model
(`items` adjacency list + fractional-index ordering, with an optional closure table) that
serves search, views, and the API. Deletes are **soft** (tombstones) so offline replicas
converge; physical deletion is confined to a tombstone-aware GC job. This split —
**CRDT decides, Postgres records and validates** — is the load-bearing idea of the whole
system.

## Conventions

- **RFC-2119 keywords** (MUST / SHOULD / MAY) mean what they say.
- Code and identifiers are `monospaced`. File references look like `path:line`.
- Every doc has a **Status** line (`Accepted` / `Proposed` / `Superseded`) and a
  **Decision owner** placeholder — fill these as the team forms.
