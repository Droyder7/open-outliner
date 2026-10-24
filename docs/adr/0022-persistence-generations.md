# ADR-0022 — Committed generations and bounded compaction

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Personal-first implementation plan

## Decision

A source revision is a per-document committed generation, not a globally allocated
update-row ID. Every append and snapshot publication advances it atomically with
its data. Existing counters continue monotonically; no data reset is needed.
A loaded snapshot binds the exact generation and its update rows through one SQL
statement. Projection advances only to that generation, so concurrent committed
changes remain pending. Destructive compaction truncates an exact set of decoded
input row IDs, retaining concurrent appends even if their IDs were allocated
before the snapshot. Corruption aborts compaction and strict projection loads.

Projection locks all claimed item identities in sorted order, checks ownership,
and scopes conflict updates to the same document. An invalid claim aborts the
transaction. Yjs owns note content; legacy API note writes return bad_request.
These corrections supersede the conflicting max-update-ID interpretation in
ADR-0013/0015; accepted historical records are unchanged.

## Evidence

persistence-safety.integration.test.ts reproduces concurrent append/truncation,
stale snapshot labeling, corrupt input, and foreign-document identity claims.
