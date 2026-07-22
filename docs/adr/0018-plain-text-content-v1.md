# ADR-0018 — V1 item content is plain text; TipTap dropped for a direct `Y.Text` binding

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

`WEB` (the client shell + editor) was built against two commitments that turned out to be in
tension:

1. **Tech stack** ([ADR-0001](./0001-web-first-pwa-stack.md), [tech-stack.md](../tech-stack.md)):
   "TipTap is the rich-text editor bound to Yjs."
2. **Yjs schema** ([ADR-0008](./0008-yjs-document-schema.md)): `content` is a `Y.Text` — chosen
   specifically so text merges character-by-character, "the one place we want fine-grained CRDT
   text, not LWW."

TipTap's `Collaboration` extension binds a ProseMirror document to a Yjs **`Y.XmlFragment`**,
not a `Y.Text`. ProseMirror's document model is a tree of typed nodes with marks; a bare
character stream can't represent it. There is no supported way to point TipTap's Yjs binding at
a plain `Y.Text` — adopting TipTap as specified would have required changing the pinned schema
from `Y.Text` to `Y.XmlFragment` per item, which ADR-0008 forbids editing directly (ADRs are
immutable once Accepted; a schema change requires a superseding ADR, not a quiet substitution
made while implementing the editor).

Separately, and not forced by the schema: `Y.Text` **does** support inline formatting via
`format(index, length, attrs)` — the mechanism `y-quill`/`y-codemirror` use for bold/italic/etc.
without ProseMirror. So the schema conflict only rules out *TipTap specifically*; it does not by
itself rule out rich text. That is a separate, second decision this ADR also makes, because
`product-overview.md`'s V1 feature list ("Rich-text item content (bold/italic/links/inline code
at minimum)") was written assuming TipTap would supply it, and dropping TipTap without
addressing that line would leave the feature list overcommitted against what got built.

## Decision

**Two decisions, made together:**

**1. Drop TipTap. The client binds `RowText` directly to each item's `Y.Text`.**
Local edits are applied as a minimal prefix/suffix diff (`applyTextEdit` in
[`RowText.tsx`](../../packages/client/src/RowText.tsx)) so concurrent character edits merge
character-by-character exactly as ADR-0008 intended, without a ProseMirror layer in between.
This keeps the schema as pinned — no ADR-0008 change needed.

**2. V1 item content is plain text. Rich-text marks (bold/italic/links/inline code) are cut
from V1 scope**, not silently dropped. `product-overview.md` core-features and
`docs/roadmap.md` V1 feature list are corrected to say "plain-text item content"; rich-text
marks move to the V2 list. This is a scope cut, made because implementing a mark model
(toolbar or shortcut input, `Y.Text.format()` ranges, an export mapping for marks) is
real, unstarted work — not a consequence of the TipTap removal itself, which is orthogonal.

`content_json` (the nullable JSONB column reserved in `migrations/0001_init_v1.sql` for a rich
snapshot) is unaffected structurally — it remains reserved, unwritten in V1, and available
for a V2 mark model to populate without a migration.

## Consequences

- **Easier / correct:** the client editor binding matches the pinned Yjs schema exactly — no
  fragment↔text bridge, no risk of the materializer's plain-text `content` projection silently
  losing structure a `Y.XmlFragment` would carry. One fewer dependency (`@tiptap/*`,
  `@hocuspocus/provider`'s TipTap-oriented `Collaboration` extension) — the client bundle and
  the package surface both shrink.
- **Newly required:** V2 rich-text work is unblocked-but-unstarted — a mark model on `Y.Text`
  (`format()` ranges, not a new schema field), a minimal formatting UI, and updated Markdown/JSON
  export mappings for marks (ADR-0016 already anticipated marks in JSON export; that text is
  now aspirational for V2, not a V1 deliverable).
- **Accepted downside:** V1 ships without bold/italic/links/inline code, which
  `product-overview.md` named as a V1 feature. This is a genuine scope reduction from the
  original product bar, made explicit here rather than left as a gap between docs and code.

## Alternatives considered

- **Change ADR-0008 to `Y.XmlFragment`, keep TipTap:** gets rich text and TipTap's editing UX,
  but is a bigger, riskier change made under implementation pressure — it touches the
  materializer's plain-text projection contract, the export JSON shape, and every doc that
  cites `Y.Text`. Rejected for V1; a superseding ADR can make this move deliberately later if
  V2 wants TipTap specifically rather than a lighter `Y.Text`-native mark model.
- **Keep the rich-text commitment, build a custom `Y.Text` mark model now:** technically
  compatible with ADR-0008 (no schema change needed), but is unscoped, unstarted work bundled
  into what was meant to be the "close the vertical slice" phase. Deferred to V2 rather than
  built under this phase's gate.
- **Ship TipTap against `Y.Text` via a lossy fragment→text serializer:** discards marks on every
  remote merge (the serializer would need to reconstruct a `Y.XmlFragment` view from plain text
  with no mark data to reconstruct from). Rejected — worse than plain text, since it looks
  rich-text-capable locally but silently loses formatting the moment another replica's edit
  merges in.

## Cross-references

- [ADR-0001](./0001-web-first-pwa-stack.md) — named TipTap as the rich-text editor; corrected by
  this ADR (TipTap dropped for V1).
- [ADR-0008](./0008-yjs-document-schema.md) — the `Y.Text` schema this decision honors rather
  than changes.
- [ADR-0016](./0016-export-contract.md) — export contract's rich-text/marks language is V2-scope
  as of this ADR; V1 export serializes plain text.
- [ADR-0017](./0017-editor-interaction-model.md) — the keymap/interaction model this binding
  implements; unaffected by this decision (structural commands, not content formatting).
- [product-overview.md](../product-overview.md) — V1 core features corrected: plain-text content
  in V1, rich-text marks moved to V2.
- [roadmap.md](../roadmap.md) — V1/V2 feature lists corrected to match.
