# ADR-0004 — CRDT decides, Postgres records and validates

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

The design has two framings that look contradictory: "treat Postgres as a projection of CRDT
state" versus a relational schema full of constraints and (optionally) triggers. An
implementer could wire up both as authorities and have them fight — e.g. a DB cascade racing
a concurrent CRDT move-in. We need one reconciling rule, and we need to name the component
that writes the relational rows (the report left it implicit).

## Decision

**The CRDT (Yjs) layer is the only conflict resolver. A server-side materializer projects
merged CRDT state into Postgres. Postgres constraints/triggers are integrity guards on an
already-resolved write — never a second resolver.**

- Structure + text live in Yjs; all LWW-parent / list-order / cycle resolution happens
  **before** anything touches Postgres.
- The materializer runs in a **Hocuspocus `onChange`/`onStoreDocument` hook**, debounced,
  diffing the `Y.Map`/`Y.Array` of items against the last projected snapshot and upserting
  rows under a per-document advisory lock.
- The projection is **idempotent and rebuildable**: drop and re-project `items` from Yjs
  state at will.

## Consequences

- **Easier:** conflicts never reach SQL, so the DB never sees an inconsistent state; the
  projection is a disposable cache — a projector bug is recoverable, not data loss; migrations
  can rebuild the projection.
- **Newly required / hard rules:**
  - Application code and triggers **must not** mutate structure out from under the CRDT — a
    direct `items` write is silently overwritten next pass.
  - **No cascades, no DB-side deletes** (see ADR-0006): the DB is downstream, so `parent_id`
    is `RESTRICT` and physical deletes live only in GC. The "cascade delete vs concurrent
    move-in" race cannot occur.
  - If a projected write violates a constraint (one-root, RESTRICT), that is a **projector
    bug to fix**, not a conflict to arbitrate in SQL.
- **Durability asymmetry:** back up the CRDT plane (`yjs_updates`) hardest; the `items`
  projection is regenerable.

## Alternatives considered

- **Postgres-authoritative (DB resolves conflicts via constraints/optimistic concurrency):**
  simpler mental model with a central backend, but fails offline-first — it can't merge
  concurrent offline tree moves the way a CRDT does, and pushes move-conflict resolution into
  fragile SQL.
- **No relational projection (query Yjs directly):** loses cheap `SELECT ... WHERE`, search,
  views, and API ergonomics. The projection exists precisely to serve those.
