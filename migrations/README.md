# Migrations

This directory holds the **authoritative relational schema** for Open-Outliner, as ordered,
forward-only SQL migrations. This is the schema of record — [`docs/data-model.md`](../docs/data-model.md)
is decided commentary on it, and [`idea-research-report.md`](../idea-research-report.md) is
exploratory history, **not** authority.

## Files

| File | What it does |
|------|--------------|
| `0001_init_v1.sql` | V1 baseline: tenancy, `items` (adjacency + fractional rank), tags, membership, change log, `yjs_updates`. |

## Conventions

- **Forward-only, numbered, immutable once merged.** Never edit a migration that has shipped;
  add a new higher-numbered one.
- Each migration is wrapped in a single `BEGIN … COMMIT` so it applies atomically.
- Extensions used: `pgcrypto` (`gen_random_uuid()`), `citext` (case-insensitive tags).

## The design invariants baked into `0001`

- **CRDT decides, Postgres records** ([ADR-0004](../docs/adr/0004-crdt-decides-postgres-records.md)):
  these tables are the queryable **projection** of the Yjs document. Constraints are integrity
  guards on an already-resolved write, never conflict resolvers.
- **No cascade on the item tree** ([ADR-0006](../docs/adr/0006-soft-delete-and-tombstone-gc.md)):
  `items.parent_id` is `ON DELETE RESTRICT`; deletes are soft (`deleted_at`); physical removal
  is a separate tombstone-aware GC job.
- **Fractional ordering** ([ADR-0005](../docs/adr/0005-fractional-indexing-ordering.md)):
  `rank TEXT COLLATE "C"`, not unique; total order is `(rank, id)`.
- **One live root per document**: a partial unique index (`items_one_root_per_doc_idx`), not a
  CHECK.
- The Yjs-field → column mapping is pinned in [`docs/yjs-schema.md`](../docs/yjs-schema.md).

## Deferred to later migrations (V2 — intentionally NOT in `0001`)

These are specified in the research report / docs but are out of V1 scope. Each lands in its own
future migration when the corresponding subsystem begins:

| Object | Why deferred |
|--------|--------------|
| `item_closure` (ancestor/descendant + `depth`) | Read accelerator; V1 ships adjacency + recursive CTEs only ([ADR-0003](../docs/adr/0003-hierarchy-adjacency-plus-closure.md)). |
| `ltree` / materialized `path` | Alternative read cache; pick closure *or* ltree, not both — decide when needed. |
| `item_refs` (mirrors / multi-parent DAG) | V2 transclusion feature; its FK is the deliberate `ON DELETE CASCADE` exception. |
| `views` (board / table) | V2 alternate views over the same tree. |
| `search_tsv` + GIN index | V2 server-side full-text search ([docs/search.md](../docs/search.md)). |

## Applying (local dev, until tooling lands)

```sh
psql "$DATABASE_URL" -f migrations/0001_init_v1.sql
```

A migration runner (and rollback strategy) is part of `FND`/`REL` and will replace manual `psql`
application; until then, apply files in numeric order exactly once against a fresh database.
