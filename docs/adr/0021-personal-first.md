# ADR-0021 — Personal-first, local-first product direction

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Repository owner, approved delivery plan

## Context

The prior product attempted personal outlining and team collaboration together.
The owner prioritizes personal capture, development, retrieval, and recovery.

## Decision

Keep React/TypeScript, Yjs, IndexedDB, Node and PostgreSQL; simplify incrementally.
The first release is plain text with notes, completion, local navigation/search,
background personal-device sync, trash, history and portable exports. Existing
cached data must open without an online identity/catalog lookup. Team expansion,
rich text, backlinks, mirrors, boards, and multi-server operation are deferred.
S3 is optional; a text-first installation must not need an object store.

Native Yjs chooses concurrent placement winners. HLC payloads do not imply a
custom merge comparator. Shared deterministic effective-tree interpretation
keeps cycles/orphans recoverable. Unique delete records and acknowledgements of
observed deletes implement explicit restore; automatic physical deletion is off.
Recovery history is retained until explicit cleanup. Checkpoint recovery creates
a new document. A new schema rejects incompatible old clients before sync.

The implementation sequence and gates live in personal-first-plan.md. Data reset
is limited to identified development data after verified exports. Never treat
sync, local persistence, server commit, and backup as interchangeable promises.

This supersedes conflicting scope/behavior in ADR-0002, 0008–0013, 0017 and 0019;
those historical accepted records remain immutable. Plain-text export still
follows ADR-0016/0018; GC preparation still follows ADR-0020.

## Consequences

Reliability and the personal workflow precede feature breadth. PostgreSQL still
owns identity and server bookkeeping; document-owned fields have one write path.
No rewrite or new framework is required. Browser and failure/interleaving tests
are release gates alongside unit tests.
