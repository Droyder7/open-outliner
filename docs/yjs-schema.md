# 04a — Yjs Document Schema (pinned)

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-22

This is the **living reference** for the Yjs document that both the client editor binding and
the server materializer implement against. The *decision* and its rationale are in
[ADR-0008](./adr/0008-yjs-document-schema.md) (shape + order model),
[ADR-0009](./adr/0009-move-clock-hlc.md) (the move clock),
[ADR-0010](./adr/0010-atomic-move-register.md) (the move is one atomic register), and
[ADR-0011](./adr/0011-crdt-tombstone.md) (delete is a CRDT register). This doc is the
field-by-field contract; if it and an ADR disagree, the ADR is the decision and this doc is
corrected to match.

## The document

One Open-Outliner document = one Yjs document. Its authoritative structure is a single
top-level `Y.Map` named `items`, keyed by item id, whose values are per-item `Y.Map`s. There
is **no** `Y.Array` of child order in V1 — order is the LWW `rank`, and `rank` lives inside the
atomic `move` register (ADR-0008, ADR-0010).

```
ydoc.getMap("items") : Y.Map<itemId, Y.Map>

itemNode (Y.Map):
  move        : Y.Map     — atomic structural register (ADR-0010); replaced whole per move:
                              parentId : string   — null-sentinel for the synthetic root
                              rank     : string   — fractional index, byte-wise (COLLATE "C") domain
                              hlc      : Y.Map      — HLC { wallMs, counter, replicaId } (ADR-0009)
  deleted     : Y.Map     — tombstone register (ADR-0011):
                              isDeleted : boolean  — LWW; true = tombstoned
                              hlc       : Y.Map     — HLC guarding the delete/undo ordering
  type        : string   — LWW enum: 'bullet' | 'task' | 'heading' | 'divider'
  content     : Y.Text   — collaborative text, bound directly (no editor framework); V1 is
                              plain text, marks deferred to V2 (ADR-0018)
  isCompleted : boolean  — LWW
  isCollapsed : boolean  — LWW
  note        : Y.Text?   — optional Dynalist-style note body (collaborative)
```

- **Read order** of a parent's children is `(move.rank, id)` — `rank` ascending, ties broken by `id`.
- **`content`** is the only fine-grained CRDT text field; everything else is a plain LWW value.
- **`move`** is one atomic register: `parentId`, `rank`, and `hlc` are written together in a
  single transaction and never independently, so a concurrent edit cannot produce a torn
  `{parentId from A, rank from B}` placement (ADR-0010). A structural write applies iff its
  `move.hlc` is strictly greater by the ADR-0009 comparison.
- **`deleted`** is an explicit register, not the absence of a key: delete sets
  `isDeleted:true` with a fresh HLC; undo sets `isDeleted:false` with a strictly-greater HLC.
  This is what makes offline delete converge and undo deterministic (ADR-0011). GC removes the
  key only after the retention window.
- **Synthetic root:** exactly one item per document has the null-sentinel `move.parentId`.
  Enforced in the projection by `items_one_root_per_doc_idx`.

## Plane ownership

Every item attribute lives in exactly one authoritative plane. **Yjs owns structure, order,
text, delete state, and user-toggled flags.** The **relational/API plane owns server-assigned
bookkeeping** that must never be a merge subject. The materializer only ever *reads* Yjs-plane
fields and only ever *writes* API-plane columns (plus the projected mirror of each Yjs field);
it never treats a projected `items` column as authoritative for a Yjs-owned attribute.

| Attribute | Authoritative plane | `items` column | Notes |
|---|---|---|---|
| item id | Yjs (map key) | `id` | client-generated UUID; stable identity |
| `move.parentId` | **Yjs** | `parent_id` | LWW; null-sentinel → SQL `NULL` (root); atomic with rank+hlc (ADR-0010) |
| `move.rank` | **Yjs** | `rank` | LWW fractional index; `TEXT COLLATE "C"`; atomic with parentId+hlc |
| `move.hlc` | **Yjs** | — (drives `version`) | winning HLC determines the structural winner; see below |
| `deleted` (isDeleted+hlc) | **Yjs** | `deleted_at` | LWW tombstone register (ADR-0011); projects to `deleted_at` timestamp |
| `type` | **Yjs** | `type` | LWW; V1 enum subset (see below) |
| `content` (Y.Text) | **Yjs** | `content` / `content_json` | `content` = plain-text projection for search; `content_json` = rich snapshot |
| `note` (Y.Text) | **Yjs** | `note` | optional |
| `isCompleted` | **Yjs** | `is_completed` | LWW boolean |
| `isCollapsed` | **Yjs** | `is_collapsed` | LWW boolean; view state, still per-item in V1 |
| `document_id` | API/relational | `document_id` | assigned at doc creation; not in Yjs |
| `created_at` | API/relational | `created_at` | server clock; bookkeeping, never merged |
| `updated_at` | API/relational | `updated_at` | server clock on projection write |
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

`move` (the atomic register: `parentId` + `rank` + `hlc`) is not stored as its own column in
V1. The materializer applies the CRDT-chosen winner — reading all three fields from the same
winning `move` — and bumps `version` (optimistic-concurrency counter). If per-field HLC
auditing is later needed, add a `move_hlc JSONB` column additively — no reshape.

## Materializer contract (summary)

For each entry in `ydoc.getMap("items")`, the materializer upserts one `items` row using the
Yjs-plane fields above: it reads the atomic `move` register as a unit (`parent_id` and `rank`
from the *same* winning `move`, never correlated across observations — ADR-0010), computes
`content` (plain text) from the `Y.Text`, projects the `deleted` register to `deleted_at`
(ADR-0011), and preserves the API-plane columns it owns. Each pass advances the document's
`projected_rev` monotonically and is recoverable by the catch-up sweep (ADR-0013). Full
projection mechanics, debounce, revision guard, and rebuild strategy are in
[06 — Yjs Projection](./yjs-projection.md).

## See also

- [ADR-0008](./adr/0008-yjs-document-schema.md) — the schema decision this doc references.
- [ADR-0009](./adr/0009-move-clock-hlc.md) — the HLC move clock.
- [ADR-0010](./adr/0010-atomic-move-register.md) — the move is one atomic register (no torn moves).
- [ADR-0011](./adr/0011-crdt-tombstone.md) — delete is an explicit CRDT register.
- [ADR-0013](./adr/0013-projection-revision-guard.md) — monotonic projection + catch-up.
- [05 — Fractional Indexing](./fractional-indexing.md) — the `rank` algorithm.
- [`/migrations/0001_init_v1.sql`](../migrations/0001_init_v1.sql) · [`0002_integrity_v1.sql`](../migrations/0002_integrity_v1.sql) — the relational side.
