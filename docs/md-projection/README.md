# Markdown Projection & WebDAV Vault — Research Note

**Status:** Proposed (research; no decision recorded yet)
**Date:** 2026-08-22
**Decision owner:** —

This note documents the feasibility investigation for a server-side materializer that
projects the Yjs document into Markdown files served over WebDAV, so the outline can be
consumed as an **Obsidian vault**. It is research and design groundwork, not an accepted
specification. Nothing here changes the V1 scope in [`../roadmap.md`](../roadmap.md);
implementing any of it first requires an ADR and a roadmap decision.

**Scope split (important):**

- **In scope of this note:** the read-only projection direction (Yjs → Markdown → WebDAV),
  the supporting ledger, and the WebDAV server surface.
- **Deferred — explicitly out of scope for now:** the write-back direction, in particular
  **Markdown restructure → item/CRDT reconciliation** (parsing user-edited Markdown back
  into item operations). The research findings for that direction are recorded in
  [§7](#7-deferred-markdown-restructure--itemcrdt-reconciliation) so the work is not lost,
  but it must not be implemented until a roadmap decision re-opens it.

---

## 1. Motivation and feasibility verdict

Open-Outliner already projects the CRDT into PostgreSQL for search/views/API. A second
projection into a filesystem of Markdown files would give users a live, read-only mirror
of their outline inside Obsidian (or any WebDAV client) — local-first tooling, backlinks,
plugins, and grep-ability for free, with zero client work.

**Verdict: feasible, and unusually well-served by the existing architecture.** All four
load-bearing seams already exist:

| Need | Existing seam |
|---|---|
| Change trigger | `scheduleProjection(documentId)` in the Hocuspocus `store` hook ([`packages/server/src/crdt/server.ts`](../../packages/server/src/crdt/server.ts)), plus the interval sweep pattern in [`main.ts`](../../packages/server/src/main.ts) |
| Exactly-once-per-revision semantics | `document_projection.source_rev / projected_rev` monotonic guard (ADR-0013) — a Markdown projector gets its own column by the same pattern |
| Deterministic Markdown rendering | `serializeMarkdown` in [`packages/server/src/export/serializer.ts`](../../packages/server/src/export/serializer.ts) (ADR-0016): headings, `- [ ]` tasks, `---` dividers, notes as blockquotes, `(rank, id)` order, tombstones excluded |
| Lossless content | V1 content is plain text (ADR-0018), so Markdown projection is lossless today; only V2 rich-text marks will need a marks→Markdown mapping |

Soft deletes (ADR-0006/0011) already make deleted items disappear from exports correctly.

## 2. Reference analysis: `refs/sync-engine`

`refs/sync-engine/` is an Obsidian *plugin* (client-side) that syncs a vault to WebDAV/S3.
It is the mirror image of our situation (we would be the server), but its internals are a
direct blueprint. Key borrows:

1. **UID ledger instead of content hashing.** Its sync brain is a per-path ledger
   (`RecordStat = { local uid, remote uid }`); "changed" means `current.uid !== recorded.uid`,
   with the WebDAV etag (or `mtime~size` fallback) as uid; every mutation task updates the
   ledger atomically. For us: a `vault_files` table playing ledger + merge-base roles
   (§4). Our local uid is even cheaper — the CRDT revision from ADR-0013.
2. **Decider case table.** `decision/bidirectional.ts` unions local ∪ remote ∪ record keys
   and emits one of ~11 exact cases per path. This is the correct shape for any future
   write-back reconciler — pure, table-driven, unit-testable without a real WebDAV server.
3. **smart-merge base-text store + recursive diff3.** Every materialized write saves its
   plaintext as the merge "base" in a side store; on conflict it runs a three-way token-level
   merge (`merge({a, o: base, b})`) with recursive re-splitting (document → code-block/prose
   → word/grapheme via `Intl.Segmenter`, O(NP) diff). Only leaf-level conflicts surface, with
   markers. This is the pattern for non-destructive file-vs-CRDT merging if write-back ever
   happens.
4. **`RootFs` interface as protocol spec.** Their zero-dependency WebDAV client
   (`packages/webdav/src/webdav/fs.ts`) is a precise conformance checklist for the *server*
   we must implement: Depth-infinity vs. Depth-1 PROPFIND walking, `W/`-prefixed etag
   handling on PUT, 405-tolerant MKCOL, 404-tolerant DELETE, `Link: rel="next"` pagination.
   Their test mocks (`webdav/test/mocks.ts`) are reusable as conformance fixtures.
5. **Feedback-loop hygiene.** Their Scheduler debounces vault events and ignores events while
   a sync is executing. Our WebDAV PUT handler must likewise ignore writes whose content
   matches our own `materialized_uid` (re-entrant materialization).

Not adopted: their "Anchored Asymmetric Storage" (flat remote with parent-anchor prefixes)
— our remote is our own database, not a quota'd cloud.

## 3. Proposed architecture (phased)

```
Yjs update ──► yjs-store ──► projector ──► items (PostgreSQL)
                   │                          │
                   └── scheduleVaultSync ──►  vault-materializer (new job)
                                              │ decider (vault_files ledger)
                                              ├─ ours-changed ──► render .md (serializer fan-out) ──► virtual FS ──► WebDAV (PROPFIND/GET/PUT…)
                                              ├─ theirs-changed ──► [DEFERRED — write-back, §7]
                                              └─ both ──► [DEFERRED — file-level diff3, §7]
```

**Phase 1 — read-only vault.** Per-document Markdown fan-out + `vault_files` ledger +
WebDAV server surface (PROPFIND/GET + MKCOL for traversal; PUT accepted-and-ignored or
rejected, decided in the ADR). Follows the existing interval-sweep job pattern; only the
"ours-changed" branch exists.

**Phase 2 (deferred, requires roadmap decision)** — write-back decider and diff3 merge,
per §7.

### 3.1 Item↔file mapping (the main open design decision)

The current serializer emits one flat document. An Obsidian vault wants files. Candidate
mapping: **one `.md` file per item** (filename = slugified title + short id suffix for
uniqueness; hierarchy via folders or wikilinks between parent/child notes) or **one file per
top-level branch** (children as nested bullets). Deterministic naming matters — an Obsidian
rename must not be indistinguishable from delete+create if write-back is ever enabled; the
ledger keeps the authoritative path↔item mapping either way.

YAML frontmatter (item id, rank, tags from `item_tags`, due/start dates) is cheap to emit
and is what would make a future importer lossless. Item identity anchoring via Obsidian
native block ids (`^oo-xxxx`, charset letters/numbers/dashes) is researched in §7 but only
relevant to write-back.

### 3.2 Consistency model

Markdown files are generated from the projected rows (or the Y.Doc under the same
per-document advisory lock), written to a staging area, and swapped atomically, so a WebDAV
client never observes a half-updated vault. The revision ledger gives exactly-once-per-
revision semantics, mirroring ADR-0013.

### 3.3 New HTTP surface & security

[`http/server.ts`](../../packages/server/src/http/server.ts) currently handles only
`POST /rpc` and `/health`. WebDAV needs PROPFIND/PROPPATCH/MKCOL/GET/PUT/DELETE/COPY/MOVE —
a genuinely new surface plus tenancy decisions. Session cookies (ADR-0014) do not map to
Obsidian's Basic-auth WebDAV client; the likely design is per-user minted vault
credentials, scoped to that user's documents. This must be settled in the ADR together with
self-hosting topology (a separate WebDAV port or path prefix).

## 4. `vault_files` ledger (sketch)

```sql
-- per (document, item) or (document, path); role: change detection + future merge base
vault_files (
  document_id uuid,
  path text,
  item_id uuid,            -- NULL for synthetic files (folder notes, index)
  materialized_uid text,   -- hash/revision of what we last wrote
  remote_uid text,         -- etag observed via WebDAV (write-back only; deferred)
  base_text text,          -- last materialized plaintext (merge base; deferred)
  primary key (document_id, path)
)
```

In read-only mode only `materialized_uid` is needed; the `remote_uid`/`base_text` columns
exist so Phase 2 does not require a migration.

## 5. Governance

This feature appears nowhere in `roadmap.md` or the ADRs — it is new scope, not deferred
work. Required before implementation:

1. A new ADR (does not supersede any accepted one; nearest neighbor is ADR-0016's export
   contract): decides read-only vs. eventual write-back, the item↔file mapping, the WebDAV
   auth model, and the release (V2 candidate).
2. A `roadmap.md` scope entry.
3. A `status.md` row (added as `MDP`, Needs decision, linking here).

## 6. Risks (read-only phase)

- **WebDAV conformance breadth** — Obsidian's remote-storage plugins are tolerant, but
  third-party WebDAV clients vary; the sync-engine client spec (§2.4) is the checklist.
- **Rename churn** — title edits change filenames; without stable ids in filenames, every
  title edit is a file delete+create for syncing clients. Mitigate with id-suffixed names.
- **Vault size** — one-file-per-item on large outlines; measure before choosing the mapping.
- **Feedback loops** — some Obsidian plugins write metadata back; read-only mode must not
  mistake plugin writes for user intent (they are simply ignored in Phase 1).

---

## 7. DEFERRED: Markdown restructure → item/CRDT reconciliation

> **Status: Deferred.** Everything in this section concerns the write-back direction
> (Obsidian edits flowing into the CRDT). It is recorded as research only. Do not
> implement without a roadmap decision reopening it; the split/merge ambiguity policies in
> §7.4 in particular are product decisions, not technical ones.

The problem decomposes into three sub-problems — parse Markdown into an outline tree,
reconcile two outline trees into an edit script, apply that script as CRDT ops — plus one
genuinely novel piece: the **ambiguity policy** for splits and merges.

### 7.1 Prior art

- **Logseq** proves id-anchored Markdown round-tripping for an outliner at scale: blocks
  are bullets, hierarchy is indentation, identity is an `id::` block property; files are
  reparsed and reconciled by id. Cautionary tales from its community: the format is not
  quite standard Markdown (round-trip with other tools suffers), property lines clutter
  files, and malformed ids break parsing — hence the strict dialect contract below.
- **Obsidian block ids** (`^block-id` at end of a bullet) are the Obsidian-native anchor:
  they identify just that item (not the whole list), the charset is letters/numbers/dashes,
  and Obsidian renders them invisibly in reading mode. Users can even link
  `[[note#^oo-xxxx]]` to outline items. Preferred over Logseq-style property lines.
- **Tree diff (GumTree pattern).** Phase 1: exact matching by id/hash; phase 2: fuzzy
  matching of leftovers via similarity thresholds (GumTree uses Jaccard over subtree
  content; Difftastic similar). Emit edit script from matches. Zhang-Shasha optimal tree
  edit distance is *not* wanted — too slow and semantically meaningless matches.
- **Content updates within a matched item:** the Yjs-binding pattern — diff old vs new
  string with `fast-diff`, translate chunks into sequential `Y.Text.delete/insert` calls
  with a running cursor (preserves character-level CRDT history for concurrent merges).

### 7.2 Dialect contract

The serializer must emit a Markdown subset the parser reads back losslessly: nested bullets
for hierarchy (unbounded depth; heading-*type* items render inside bullets, not as `#`,
since ATX headings cap at 6 levels), `- [ ]`/`- [x]` tasks, `>` line under a bullet for
notes, `---` dividers, `^oo-xxxx` anchor per bullet, file-level YAML frontmatter.
Enforced by a property test: `parse(serialize(tree)) === tree` over generated outlines.
Non-dialect content a user writes (tables, images, paragraphs) needs an explicit policy
(attach to nearest item's note vs. per-file "unmapped" section) — never silent drop.

### 7.3 Reconciler sketch

Under the existing per-document advisory lock (single structural writer):

```
reconcile(oldTree /* from CRDT, anchors known */, newTree /* parsed */):
  M1 = matchByAnchor(old, new)             // exact (block ids)
  M2 = matchIdenticalText(leftovers)       // cheap exact pass
  M3 = fuzzyMatch(remaining, scope = sibling groups,
                  sim = normalized-text dice/Jaccard, threshold ≈ 0.6,
                  tiebreak = sibling-order LCS)
  matched + text changed   → fast-diff → Y.Text ops
  matched + parent changed → atomic move register op (ADR-0010)
  matched + order changed  → regenerate fractional rank (ADR-0005)
  old unmatched            → tombstone (LWW deleted register, ADR-0011)
  new unmatched            → create item; adopt user-typed ^oo- anchor as id
```

Scoping fuzzy matching to sibling groups bounds blast radius: a mis-parsed indent cannot
cascade beyond one parent's children. Ops flow through the normal write path
(`storeUpdate` → Hocuspocus propagation), so all clients converge and the projector stays
consistent for free; cycle safety re-checked post-batch (ADR-0012).

### 7.4 Split/merge ambiguity policies (product decisions, deferred)

- **Split** (one bullet → two): old item matches the *first* fragment; other fragments are
  new items with adjacent ranks; the old item's children and note follow the first fragment
  (Dynalist/Workflowy semantics). Alternatives (children to last fragment, or promoted)
  are defensible — must be decided in the future ADR.
- **Merge** (two bullets → one): first (sibling order) survives with merged text; the other
  is tombstoned with its children re-parented to the survivor.
- **Below-threshold rewrites:** tombstone + create — correct for an outliner, where
  identity is text + position history; recoverable via soft delete and CRDT history.

Safety invariant: every destructive decision is a tombstone, never a hard delete;
unmatched old items with non-empty subtrees can be held for a confirmation pass
(sync-engine's confirmation-gate pattern).

### 7.5 Layering with the file-level merge

When both the CRDT and the file changed: first run the sync-engine-style diff3
(file vs `base_text` vs freshly materialized text). Clean merge → reconcile the merged
file. Conflict markers → do not write back; re-materialize with the conflict marked and
let the human resolve in the outliner, where the CRDT-side structural opinion already
exists.

### 7.6 Risks unique to write-back

- **Indentation fragility:** a parser off-by-one on list-item content columns turns
  "re-indent" into mass tombstone+create (recoverable, ugly). Mitigation: exact-text match
  before structural match; sibling-scoped fuzzy matching.
- **Anchor stripping:** users or plugins deleting `^oo-` anchors degrades matching to
  fuzzy-only; the ledger retains anchor→id history so previously-seen anchors still match.
- **Test burden:** property-based round-trip tests, restructure scenario tests
  (split/merge/reindent/reorder/rename/delete-branch), fuzz harness asserting the pipeline
  is idempotent after one pass, golden files for the dialect.
