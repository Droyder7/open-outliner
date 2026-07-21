# 08 — Full-Text Search

**Status:** Accepted (spec) · **Ships:** V2 · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

Server-side search is a **V2** feature, but it's specified now so the schema doesn't need
reshaping later. This mirrors the report §"Full-Text Search".

## Decision summary

| Concern | Decision |
|---------|----------|
| Engine | Postgres native **`tsvector` + GIN** — no external search service for V1/V2 |
| Column | `search_tsv` on `items`, `GENERATED ALWAYS AS ... STORED` from `content_text` |
| Dictionary | Start with **`simple`** (no stemming) for predictable outline search |
| Scope | Always **tenant/document-scoped first**, then rank |
| Offline search | **Client-side** local index over cached items |

## Server-side (Postgres)

Keep a denormalized plain-text projection of each item's content and derive a `tsvector`
from it in the same materializer pass that writes structure. Prefer a **generated column**
so it can't drift from the row:

```sql
ALTER TABLE items ADD COLUMN content_text TEXT;   -- plain-text projection of Yjs content
ALTER TABLE items ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_text, ''))) STORED;
CREATE INDEX items_search_idx ON items USING GIN (search_tsv)
  WHERE deleted_at IS NULL;
```

- **`content_text` is written by the materializer** — it extracts plain text from each
  item's `Y.Text` when projecting. → [06-yjs-projection](./yjs-projection.md)
- **Generated column over trigger:** the generated `tsvector` can't get out of sync with
  `content_text`; a trigger can.
- **Query pattern:** scope by `document_id` / workspace **first**, then match `search_tsv`
  and rank with `ts_rank_cd`. Search is always tenant-scoped — never a cross-tenant scan.
- **Dictionary:** `simple` (exact tokens, no stemming) gives predictable results for
  outlines and identifiers. Move to language configs only when users ask; if multilingual,
  store the config choice per workspace.

## Offline / client-side search

The client already holds the working set in IndexedDB, so **offline search is local**:

- Build a small inverted index (e.g. `flexsearch` / `lunr`) over cached items.
- Handles the common case (search what you're working on) with zero network.
- The server `tsvector` handles **cross-document / not-yet-loaded** results when online.

The two are complementary: local for the loaded set and offline mode, server for the long
tail and global search.

## Explicitly not doing (V1/V2)

- No Elasticsearch / OpenSearch / Meilisearch / Typesense. Postgres FTS is enough at our
  scale and keeps self-hosting to Postgres + S3. Revisit only if search volume/relevance
  demands it — a later reassessment, not a current plan.
- No semantic/vector search in V2 (possible future, out of current scope).
