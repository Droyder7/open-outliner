# 04a — Yjs Document Schema (pinned)

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-22

This is the **living reference** for the Yjs document that both the client editor binding and
the server materializer implement against. The *decision* and its rationale are in
[ADR-0008](./adr/0008-yjs-document-schema.md) (shape + order model) and
[ADR-0009](./adr/0009-move-clock-hlc.md) (the move clock). This doc is the field-by-field
contract; if it and an ADR disagree, the ADR is the decision and this doc is corrected to match.

## The document

One Open-Outliner document = one Yjs document. Its authoritative structure is a single
top-level `Y.Map` named `items`, keyed by item id, whose values are per-item `Y.Map`s. There
is **no** `Y.Array` of child order in V1 — order is the LWW `rank` register (ADR-0008).

```
ydoc.getMap("items") : Y.Map<itemId, Y.Map>

itemNode (Y.Map):
  parentId    : string   — LWW; move register; null-sentinel for the synthetic root
  rank        : string   — LWW; fractional index, byte-wise (COLLATE "C") domain
  type        : string   — LWW enum: 'bullet' | 'task' | 'heading' | 'divider'
  content     : Y.Text   — collaborative rich text, TipTap-bound
  move        : Y.Map     — HLC { wallMs, counter, replicaId } guarding parentId + rank
  isCompleted : boolean  — LWW
  isCollapsed : boolean  — LWW
  note        : Y.Text?   — optional Dynalist-style note body (collaborative)
```

- **Read order** of a parent's children is `(rank, id)` — `rank` ascending, ties broken by `id`.
- **`content`** is the only fine-grained CRDT text field; everything else is a plain LWW value.
- **`move`** is a single HLC shared by `parentId` and `rank` so a concurrent text edit cannot
  stomp a move and vice-versa (ADR-0009). A structural write applies iff its `move` is strictly
  greater by the ADR-0009 comparison.
- **Synthetic root:** exactly one item per document has the null-sentinel `parentId`. Enforced
  in the projection by `items_one_root_per_doc_idx`.

## Plane ownership

Every item attribute lives in exactly one authoritative plane. **Yjs owns structure, order,
text, and user-toggled flags.** The **relational/API plane owns server-assigned bookkeeping**
that must never be a merge subject. The materializer only ever *writes* API-plane columns; it
only ever *reads* Yjs-plane fields.

| Attribute | Authoritative plane | `items` column | Notes |
|---|---|---|---|
| item id | Yjs (map key) | `id` | client-generated UUID; stable identity |
| `parentId` | **Yjs** | `parent_id` | LWW; null-sentinel → SQL `NULL` (root) |
| `rank` | **Yjs** | `rank` | LWW fractional index; `TEXT COLLATE "C"` |
| `type` | **Yjs** | `type` | LWW; V1 enum subset (see below) |
| `content` (Y.Text) | **Yjs** | `content` / `content_json` | `content` = plain-text projection for search; `content_json` = rich snapshot |
| `note` (Y.Text) | **Yjs** | `note` | optional |
| `isCompleted` | **Yjs** | `is_completed` | LWW boolean |
| `isCollapsed` | **Yjs** | `is_collapsed` | LWW boolean; view state, still per-item in V1 |
| `move` (HLC) | **Yjs** | — (drives `version`) | winning HLC determines projection order; see below |
| `document_id` | API/relational | `document_id` | assigned at doc creation; not in Yjs |
| `created_at` | API/relational | `created_at` | server clock; bookkeeping, never merged |
| `updated_at` | API/relational | `updated_at` | server clock on projection write |
| `deleted_at` | API/relational | `deleted_at` | soft-delete tombstone; set by delete command → projected |
| `version` | API/relational | `version` | optimistic-concurrency counter for the API path |
| `color`, `metadata` | API/relational (V1) | `color`, `metadata` | non-structural; API-managed until proven collaborative |
| `due_at`/`start_at`/`recur_rule` | API/relational (V1) | those columns | parsed/derived; not CRDT-merged in V1 |
| tags | API/relational | `item_tags` | derived from content parse or API; not a Yjs field in V1 |
| `content_text` / `search_tsv` | API/relational | (V2 search) | derived projection only |

### Type enum

The SQL `item_type` enum carries all six historical values (`bullet, task, heading, divider,
board, table`) because removing enum values later is painful. **V1 clients only ever write the
four structural types** `bullet | task | heading | divider`; `board`/`table` are V2 view types
and MUST NOT be produced by the V1 editor.

### `move` → `version`

`move` (the HLC) is not stored as its own column in V1. The materializer applies the
CRDT-chosen winner and bumps `version` (optimistic-concurrency counter). If per-field HLC
auditing is later needed, add a `move_hlc JSONB` column additively — no reshape.

## Materializer contract (summary)

For each entry in `ydoc.getMap("items")`, the materializer upserts one `items` row using the
Yjs-plane fields above; it computes `content` (plain text) from the `Y.Text`, preserves the
API-plane columns it owns, and applies soft-deletes as `deleted_at`. Full projection mechanics,
debounce, and snapshot-diff strategy are in [06 — Yjs Projection](./yjs-projection.md).

## See also

- [ADR-0008](./adr/0008-yjs-document-schema.md) — the decision this doc references.
- [ADR-0009](./adr/0009-move-clock-hlc.md) — the HLC move clock.
- [05 — Fractional Indexing](./fractional-indexing.md) — the `rank` algorithm.
- [`/migrations/0001_init_v1.sql`](../migrations/0001_init_v1.sql) — the relational side.
