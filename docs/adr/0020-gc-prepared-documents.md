# ADR-0020 — Prepare and retain GC documents before acquiring their lock

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Repository owner, approved implementation plan

## Context

Issue #4 identifies full-history replay inside GC's per-document advisory lock.
The cold-document key-removal fallback reconstructs the entire Yjs document while
projection and compaction wait. Compaction reduces stored updates, but does not
remove that lock dependency. Moving a detached snapshot outside the lock would
require a separate revision-validation protocol.

## Decision

After a cheap eligibility check, GC opens a Hocuspocus direct connection before
acquiring the advisory lock. It reuses or loads the canonical room and retains it
while GC runs, even when the last browser disconnects. The preparation returns a
document-specific handle with `remove(itemIds)` and `release()`.

Inside the lock, GC rechecks retention, leaf status, replica acknowledgements,
and current unsynced connections. `remove` transacts on the retained document
and immediately persists the deletion delta. It never loads history or falls
back to a detached document. Only after persistence succeeds may GC soft-delete
attachments and hard-delete projected item rows.

Preparation or removal failures skip relational deletion for that document.
The handle is released in `finally` after the lock transaction commits or rolls
back. Release may flush and unload the room; cleanup failures are logged without
masking the original error or changing an already-committed deletion count.
Documents run sequentially; overlapping passes on the same worker return zero.

The internal preparation interface replaces the former removal callback. A
headless adapter loads its document during preparation for store-only tests.
Production always uses Hocuspocus. Retention, batch sizes, replica pruning,
compaction, and deferred S3 cleanup retain their existing policies.

This refines the GC execution path described by ADR-0006/0019 and retains the
durability boundary in ADR-0015. The accepted records remain unchanged. There
are no schema or external API changes.

## Consequences

- Projection and compaction no longer wait for GC's cold-document replay.
- Cold documents temporarily consume room memory. At most one GC preparation
  is active per worker, and its direct connection is always released.
- Hocuspocus can encode/store the room again on disconnect. Cold-pass completion
  can be slower despite much shorter lock duration; this change targets contention.
- CRDT persistence and projected-row deletion remain separate transactions.
  A later SQL failure does not undo an already-durable CRDT deletion; subsequent
  projection/GC passes reconcile the retained tombstone row.
- Release failure can leave an idle room in memory until its normal lifecycle
  completes; the direct-connection count is decremented by Hocuspocus before its
  persistence hook runs. Such failures must remain visible in logs.

## Alternatives considered

- **Detached snapshot and revision checks:** more concurrency machinery than
  needed when the collaboration server already provides a retained document.
- **Compaction alone:** reduces replay cost but still performs it under the lock.
- **Permanent loaded rooms:** avoids replay but retains idle documents indefinitely.

## Evidence

- [Lifecycle integration tests](../../packages/server/test/gc-lifecycle.integration.test.ts)
  cover lock isolation, eligibility races, failures, room retention, and compaction.
- [Validation and measurements](../gc-lock-validation.md) record the 10k-item comparison.
