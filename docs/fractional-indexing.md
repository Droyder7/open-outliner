# 05 — Fractional Indexing

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

How siblings are ordered. This is the production-proven combination the report converges
on; the deep material is in report §"Implementing Fractional Indexing" and §"Strategies for
Lexicographical Index Collisions in Offline Sync".

## Decision summary

**String fractional indexing** on a `rank TEXT COLLATE "C"` column, with:

- **Jitter at generation time** to lower concurrent-collision rate.
- **`(rank, id)` as the total order** — `rank` is *not* unique; ties are legal and broken by `id`.
- **`COLLATE "C"`** for byte-wise lexicographic ordering (non-negotiable).
- **`openSpace` when inserting between collided ranks.**
- **LWW on the `rank` field** when merging concurrent moves.
- **No `UNIQUE(parent_id, rank)` constraint** — uniqueness lives on `item_id`, not position.

→ [ADR-0005](./adr/0005-fractional-indexing-ordering.md)

## Why not the obvious alternatives

| Approach | Why rejected |
|----------|--------------|
| Integer `position` | Insert-between forces renumbering all following siblings — terrible for offline/concurrent clients. |
| Float midpoints (Figma's first idea) | Runs out of float precision after ~50 midpoint inserts between the same neighbors; hits denormals. |
| `UNIQUE(parent_id, rank)` | Turns a benign concurrent collision into a hard DB error; fights LWW merges. **Avoid.** |

## How it works

`rank` is a short string that sorts lexicographically between its neighbors. Insert between
`"a0"` and `"a1"` → `"a0V"`. Insert between two siblings updates **only the moved item's
rank** — no neighbor touches. That locality is the whole point: it's what makes offline
inserts and CRDT merges cheap.

- **Character set:** an ordered alphabet (e.g. base-62-ish) compared byte-wise.
- **Midpoint with length control:** compute a string strictly between two bounds, growing
  length only when the gap is exhausted.
- **Append/prepend** without midpoint blow-up at the ends.
- **API surface:** `rankBetween(a, b)`, `rankAfter(a)`, `rankBefore(b)`, plus `openSpace`.

## The rules that make it safe under concurrency

These are the parts people get wrong; they are decided, not optional.

1. **Total order is `(rank, id)`, never `rank` alone.** Two offline clients can generate the
   *same* rank for different items. That's fine — the tie-break on `id` gives a stable,
   deterministic total order. Uniqueness is on `item_id`.
2. **`COLLATE "C"`.** Postgres locale-aware collations do **not** order these strings the way
   the generator assumes. The column MUST be `COLLATE "C"` (byte-wise) or ordering silently
   diverges between client and server.
3. **Jitter.** When two clients independently insert "between A and B" while offline, a
   deterministic midpoint makes them collide every time. A small random jitter in the split
   spreads them out (birthday-bound math in the report). Vary by content, not by a shared
   deterministic midpoint.
4. **`openSpace` on collision.** When inserting between two items that already share a rank,
   open space rather than producing an ever-growing key.
5. **LWW on `rank`.** Concurrent moves merge last-writer-wins on the rank field (with
   `timestamp`, `replicaId`), consistent with the parent register. → [04-sync](./sync-and-conflict-resolution.md)
6. **Rebalance is an escape hatch, not a routine.** If keys grow pathologically long,
   a rebalance worker (V2) reassigns ranks and broadcasts them as normal LWW rank updates
   with bumped clocks, so offline peers converge. Offline clients holding old ranks lose the
   LWW — acceptable because rebalance is rare.

## Known wart: interleaving

Two users concurrently typing *interleaved* new siblings can produce an order that
technically satisfies every rank but reads as interleaved rather than grouped. This is a
known semantic wart of bare fractional ranks (documented in the report). Acceptable for V1;
a full list-CRDT (V2) removes it at the cost of weight.

## Postgres integration

```sql
-- rank column
rank TEXT NOT NULL COLLATE "C",
CREATE INDEX items_parent_rank_idx
  ON items (document_id, parent_id, rank)
  WHERE deleted_at IS NULL;
-- NO unique constraint on (parent_id, rank)
```

- **Write path:** compute `rankBetween(prev, next)` on the client; send it with the op.
- **Move:** update `parent_id` + a fresh rank under the destination parent in one logical op;
  merge with LWW.
- **Validation:** the projector may re-check ordering but must not reject a benign collision.

## Testing checklist (must pass)

- Insert between adjacent ranks 1000× → keys stay bounded, order preserved.
- Two offline clients insert "between A and B" → converge to a stable order via `(rank, id)`.
- `COLLATE "C"` vs default collation produce identical order to the JS generator.
- Concurrent move + insert → LWW resolves without a unique violation.
- Rebalance → offline client with stale ranks converges after sync.

→ Full matrix in report §"Testing matrix for offline collision" and §"Testing Checklist".
