# ADR-0002 — Yjs CRDT over a local-first sync engine

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

Real-time + offline is the crucial decision. Two families exist: (A) a CRDT engine (Yjs)
with our own WebSocket transport/persistence, or (B) a local-first "replicated DB" engine
(Replicache, ElectricSQL, PowerSync, Jazz) that exposes a mutation/query API and merges via
CRDT-like logic. We also considered OT (operational transform).

## Decision

Use **Yjs** as the CRDT engine, transported by **Hocuspocus**. Reject OT. Defer the
local-first-engine family for possible later reassessment.

## Consequences

- **Easier:** Yjs is the de-facto standard in the collaborative-editor niche, with the
  richest TipTap binding and the most reference implementations; it handles offline edits and
  network partitions natively; we keep full control of how Yjs maps onto Postgres rows.
- **Harder / newly required:** we design our own persistence, presence/awareness, and
  permissions on top of Yjs; we must build the projection layer (ADR-0004). Yjs adds
  conceptual overhead (CRDT awareness).
- Tree **moves** — the hard concurrency case — are handled with LWW-parent + LWW fractional
  `rank` (HLC tie-break; see ADR-0005, ADR-0008, ADR-0009 and the sync doc) rather than OT
  transforms, which get genuinely hard for moves.

## Alternatives considered

- **OT (server-authoritative):** workable only with a central authority and simpler needs;
  transforming concurrent tree moves is where OT breaks. Fails our offline-first bar.
- **Local-first DB engines (Pattern 2):** simpler mutation/query API and excellent offline
  semantics, but less proven for complex tree/outline editors and several are younger/less
  standard. Revisit if our Yjs persistence/permissions design cost outgrows its benefit — a
  future reassessment, not a current plan.
- **Firebase/Firestore hosted realtime:** conflicts with self-host / own-your-data.
