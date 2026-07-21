# ADR-0016 — Export contract: Markdown + JSON round-trip

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

"Own your data" is product principle #5 — export is called a first-class feature, "not an
afterthought." But no export *contract* existed: no format, no fidelity guarantee, no ordering
rule, no policy for deleted content or attachments, and no round-trip test. Without those,
"own your data" is a slogan, not a shippable capability, and the export acceptance gate cannot
become measurable.

Two distinct user needs pull in different directions:

1. **Readable data out** — a human wants their outline as a file they can read, diff, or paste
   elsewhere. Markdown is the lingua franca.
2. **Faithful backup / migration** — a user (or a self-host migration) needs a *lossless*
   representation that can be re-imported to reconstruct the outline exactly, including ids,
   order, types, timestamps, and rich-text marks that Markdown cannot fully carry.

One format cannot serve both without compromise, so the contract provides both.

## Decision

V1 export produces **two formats from the same snapshot**: a human-readable **Markdown** file
and a full-fidelity, **round-trippable JSON** file.

### Markdown (human-readable, lossy by design)

- Nested bullet list mirroring the outline hierarchy; one item per bullet, indented by depth.
- Rich text rendered to Markdown inline syntax (bold, italic, links, inline code — the V1
  rich-text set from product-overview). Item `type` maps to the nearest Markdown construct
  (heading → `#`, task → `- [ ]`/`- [x]`, divider → `---`, bullet → `-`).
- **Lossy and explicitly so:** ids, ranks, exact timestamps, and any mark Markdown can't
  express are not preserved. Markdown is for reading, not for round-trip.

### JSON (full-fidelity, round-trippable)

- A complete serialization of the exported items: `id`, `parentId`, `rank`, `type`, rich-text
  **content in a structured form** (not flattened to plain text — preserves marks TipTap/Yjs
  carry), `isCompleted`, `isCollapsed`, and timestamps.
- **Round-trip is a defined contract:** importing an exported JSON reconstructs an
  equivalent outline — same hierarchy, same sibling order, same content and item metadata.
  Re-import assigns fresh ids where needed for conflict-free insertion into a target workspace,
  but preserves structure and order.

### Ordering — deterministic

Both formats emit siblings in the canonical **`(rank, id)`** order (the same total order the
projection reads, ADR-0005/ADR-0008). Export is therefore **deterministic**: the same document
state always produces byte-identical output, which is what makes a round-trip test and a
diff-based backup meaningful.

### Deleted content — excluded

Tombstoned items (CRDT `deleted` register set, ADR-0011) are **excluded** from both formats by
default. Export reflects the live outline, not its trash. (A future "include trash" option is a
non-breaking addition; not V1.)

### Attachments — referenced, resolvable

- JSON records each attachment reference by its stable attachment id plus enough metadata
  (`mime`, `size`, server `checksum`) to re-resolve it. A full "export the blobs too" bundle
  (outline JSON + the S3 objects) is the backup story owned by the self-host backup procedure
  ([self-hosting.md](../self-hosting.md)), not the per-user export.
- Markdown links attachments by a resolvable reference/URL; it does not inline binary data.

### Round-trip acceptance test (defines the gate)

The export gate is **Verified** when an automated test proves: export a non-trivial document to
JSON → import into a fresh workspace → the imported outline is *equivalent* to the source under
a defined equivalence (same tree shape, same `(rank, id)` sibling order, same item `type` and
metadata, same rich-text content), with tombstoned items absent. Markdown export is checked for
structural fidelity (hierarchy + supported marks), not round-trip.

## Consequences

- **Easier / correct:** "own your data" becomes a concrete, testable capability; deterministic
  ordering makes exports diffable and backups verifiable; the two-format split serves both the
  "readable" and "faithful backup" needs without compromising either.
- **Newly required:** a Markdown serializer and a structured-content JSON serializer/deserializer
  (the JSON side reuses the Yjs/TipTap content model so marks survive); an importer that inserts
  a JSON outline into a target workspace with fresh-id assignment and rank preservation; the
  round-trip acceptance test above.
- **Accepted downsides:** two formats to maintain; Markdown is deliberately lossy (documented,
  not a bug); per-user export references attachments rather than bundling blobs (full-blob
  backup lives in the self-host procedure, keeping export lightweight).

## Alternatives considered

- **Markdown/OPML only:** readable and simple, but no faithful round-trip — "own your data"
  can't back up rich text, order, or metadata, and re-import would silently lose data. Rejected.
- **JSON only:** lossless and round-trippable, but hostile to the user who just wants readable
  notes out. Rejected in favor of shipping both.
- **Bundle blobs into the per-user export by default:** heavyweight (multi-MB exports) and
  duplicates the self-host backup path. Deferred — export references attachments; the backup
  procedure captures blobs.

## Cross-references

- [product-overview.md](../product-overview.md) — principle #5 "own your data"; the export gate.
- [ADR-0005](./0005-fractional-indexing-ordering.md) / [ADR-0008](./0008-yjs-document-schema.md) — the `(rank, id)` order export is deterministic against.
- [ADR-0011](./0011-crdt-tombstone.md) — the `deleted` register that export excludes.
- [attachments.md](../attachments.md) — the stable attachment id export references.
- [self-hosting.md](../self-hosting.md) — full-blob backup (outline + S3 objects) as distinct from per-user export.
