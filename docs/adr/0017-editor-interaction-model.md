# ADR-0017 — Editor interaction model: Workflowy-parity

**Status:** Accepted · **Date:** 2026-07-22 · **Deciders:** _TBD_

## Context

The PWA shell (`WEB`) was blocked as *Needs decision* because the **core editor interaction
semantics were unspecified** — Enter, Tab/Shift-Tab, Backspace at boundaries, split/merge,
multi-selection, copy/paste, collapse/expand, zoom, drag targets, cross-document move, focus
restoration, and invalid-operation behavior. These are **product semantics, not implementation
detail**: they define what the outliner *is* to a user, and every one of them interacts with
the CRDT structural model (atomic `move` register, ADR-0010) and the delete model (lazy
tombstone, ADR-0006/0011). Building the editor without pinning them first invites an editor
that fights the data model.

The product already names its reference: principle-level, Open-Outliner "targets the workflows
that made **Workflowy** and **Dynalist** beloved." Workflowy is the tighter, more opinionated
of the two and maps cleanly onto a single-tree outliner. Anchoring to a **known, battle-tested
interaction model** means we specify against an existing mental model users already have,
rather than inventing (and re-teaching) one.

## Decision

**V1 editor interaction is Workflowy-parity.** The following keymap and operation semantics are
the specification; each maps to a CRDT structural mutation via the command surface in
`api-and-write-path.md` (`InsertItem` / `MoveItem` / `UpdateItem` / `DeleteItem`), realized as
atomic `move`-register writes (ADR-0010).

### Keyboard model

| Key | Behavior |
|-----|----------|
| **Enter** | Split at caret: text after the caret becomes a **new sibling** below (`InsertItem` with a rank between the current item and its next sibling). Empty item + Enter at top level creates an empty sibling. |
| **Tab** | **Indent**: the item becomes the last child of its previous sibling (`MoveItem`, new parent = prev sibling, rank = end). No-op (invalid) if there is no previous sibling. |
| **Shift-Tab** | **Outdent**: the item becomes the next sibling of its parent (`MoveItem`, new parent = grandparent, rank after parent). No-op at top level. |
| **Backspace at start** | If the item is empty, delete it and place caret at end of the previous visible item. If non-empty, **merge** into the previous sibling/visible item (append text, re-parent orphaned children to the merge target), then delete the now-empty node. |
| **Delete at end** | Symmetric merge with the **next** visible item. |
| **Up/Down / Left/Right** | Caret navigation across the flattened visible order; Up/Down move between items at line boundaries. |
| **Cmd/Ctrl-↑ / ↓** | Move the current item (and its subtree) up/down among siblings (`MoveItem`, new rank). |
| **Cmd/Ctrl-Enter** | Toggle `isCompleted` (task) / primary type action. |

### Structural operations

- **Collapse / expand** — toggles `isCollapsed` (LWW register, ADR-0008). A **local view
  state**; it is a projected field but does not alter structure or order. Collapsing hides
  descendants from the flattened visible order used for caret navigation and multi-select.
- **Zoom (focus an item as temporary root)** — a client-side navigation state: the chosen item
  becomes the visible root; breadcrumb ancestors allow zooming out. Zoom changes **what is
  rendered**, never the tree. New items created while zoomed are inserted under the zoomed root.
- **Multi-selection** — a contiguous or item-level selection over the **flattened visible
  order**. Bulk operations (indent, outdent, move, delete, complete) apply the corresponding
  command to each selected subtree root; each is an independent atomic `move`/`deleted` write,
  so a bulk op is a batch of atomic mutations, not one giant one.
- **Copy / paste**
  - **Internal** (within the app): carries the structured subtree (ids re-generated on paste,
    ranks assigned to slot into the drop location) so hierarchy and rich text survive.
  - **External in**: pasted Markdown/plain text is parsed into items by indentation/bullet
    structure (best-effort); a single line becomes a single item.
  - **External out**: copy emits Markdown (matching the export Markdown mapping, ADR-0016) plus
    a structured payload for internal paste round-trip.
- **Drag reorder / re-parent** — drag drops an item (and subtree) to a new parent/position;
  commits as one `MoveItem` (atomic `move` register). **Valid drop targets** exclude the item's
  own descendants (would form a cycle); an attempted drop into a descendant is rejected in the
  UI, and even if raced concurrently the CRDT repairs any resulting cycle deterministically
  (ADR-0012). Drop position determines the new `rank`.
- **Cross-document move** — moving an item to another document is **not** a bare re-parent
  (parent lives in a different Yjs doc). V1 semantics: it is a **cut-and-reinsert** — remove
  from the source doc (tombstone) and insert an equivalent subtree into the target doc (fresh
  ids, structured content copied), performed as a coordinated API operation, not a single CRDT
  `move`. Same-document moves stay pure `MoveItem`.

### Invalid-operation behavior (uniform rule)

An operation with no valid target (Tab with no previous sibling, Shift-Tab at top level, drop
into own descendant, delete of a synthetic root) is a **no-op with a subtle affordance** — the
UI does nothing structurally and MAY give a brief non-blocking cue. Invalid operations never
throw, never partially apply, and never produce an intermediate structural state the projector
could observe.

## Consequences

- **Easier / correct:** the editor is specified against a model users already know; every
  interaction has a defined mapping to an atomic CRDT mutation, so the editor binding can't
  produce torn moves or half-applied structure; multi-select and drag reduce to batches of the
  same atomic primitives; cross-document move is honestly scoped as cut-and-reinsert rather
  than pretending a cross-doc CRDT move exists.
- **Newly required:** a TipTap/ProseMirror binding that issues every structural change as a
  single `move`-value replacement in one Yjs transaction (ADR-0010); a flattened-visible-order
  model shared by caret nav, multi-select, and collapse; a Markdown paste parser and
  copy serializer aligned with the export mapping (ADR-0016); the cross-document cut-and-reinsert
  API operation.
- **Accepted downsides:** Workflowy-parity is a **desktop-keyboard-centric** model — touch drag
  alternatives and full accessibility are **explicitly deferred to post-V1** (see
  product-overview principle #4 amendment and the `WEB` accessibility gate); merge-on-backspace
  with child re-parenting is genuinely fiddly and needs focused tests.

## Alternatives considered

- **Dynalist-parity:** a richer surface (more node types, panes, more shortcuts) — broader than
  the V1 "ship the outliner before the platform" bar and more to specify/QA. Deferred; parity
  can grow toward it in V2.
- **Custom minimal keymap:** full control but no reference to lean on, higher spec + QA burden,
  and a relearning cost for users migrating from Workflowy/Dynalist. Rejected.
- **Treat cross-document move as a CRDT move:** impossible cleanly — parent lives in a different
  Yjs document; modeling it as one atomic move would require a cross-doc CRDT the architecture
  doesn't have. Rejected in favor of explicit cut-and-reinsert.

## Cross-references

- [product-overview.md](../product-overview.md) — Workflowy/Dynalist target; principle #4 (a11y/mobile deferral); editor-semantics spec gap this closes.
- [api-and-write-path.md](../api-and-write-path.md) — the command surface each interaction maps to.
- [ADR-0010](./0010-atomic-move-register.md) — every structural change is one atomic `move` write.
- [ADR-0012](./0012-convergent-cycle-resolution.md) — cycle repair backstops an invalid/raced drop.
- [ADR-0006](./0006-soft-delete-and-tombstone-gc.md) / [ADR-0011](./0011-crdt-tombstone.md) — delete/merge semantics.
- [ADR-0016](./0016-export-contract.md) — copy/paste Markdown mapping shares the export serializer.
