# 00 — Product Overview

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

## What Open-Outliner is

An open-source, offline-first, real-time collaborative **outliner** — a tree of
infinitely nestable items you can zoom into, reorder, mirror, tag, and share. It targets
the workflows that made **Workflowy** and **Dynalist** beloved, while being
self-hostable and OSS.

The atomic unit is an **item**: a bullet with rich-text content that can have children,
a parent, siblings in a defined order, tags, dates, and links. Everything else (documents,
boards, tables, search) is a view over items.

## Who it's for

- **Individuals** who live in outlines: notes, planning, writing, GTD, knowledge bases.
- **Small teams** who want shared, real-time outlines without a SaaS lock-in.
- **Self-hosters / OSS users** who want their data in their own Postgres + S3.

The developer profile driving the stack is **backend-heavy** (Node.js, PostgreSQL,
cloud), web-first, comfortable running a small service fleet.

## Product principles

These are load-bearing; feature decisions defer to them.

1. **Offline-first, not offline-tolerant.** Every write MUST succeed locally with no
   network. Sync is a background reconciliation, never a precondition for editing.
   → [07-offline-and-pwa](./offline-and-pwa.md)
2. **Real-time collaboration is table stakes.** Concurrent editing across devices/users
   converges without a lock and without a human resolving merges.
   → [04-sync-and-conflict-resolution](./sync-and-conflict-resolution.md)
3. **The outline is sacred.** Structural operations (nest, move, reorder, mirror) MUST be
   fast, predictable, and never silently corrupt the tree (no cycles, no lost subtrees).
4. **Web-first PWA as the primary client.** One codebase installs on desktop and mobile;
   native shells come later if ever.
5. **Own your data.** Postgres + S3 you can host; export is a first-class feature, not an
   afterthought.
6. **Ship the outliner before the platform.** Boards, tables, and advanced views are V2.
   The V1 bar is "a delightful, reliable, collaborative outliner." → [12-roadmap](./roadmap.md)

## Core features (V1 scope)

- Infinite nesting; zoom into any item as a temporary root.
- Drag/keyboard reordering and re-parenting with instant local feedback.
- Rich-text item content (bold/italic/links/inline code at minimum).
- Multiple documents inside a workspace; global cross-document navigation.
- Real-time multiplayer with presence/awareness.
- Offline editing with automatic sync on reconnect.
- Tags and basic links between items.
- Soft delete with undo; export.

## Explicitly out of V1

Mirrors/transclusion (multi-parent DAG), board/table views, server-side full-text search,
permission inheritance, and attachment-heavy workflows are **V2**. They are designed-for
in the schema (so V1 doesn't paint us into a corner) but not shipped. See
[12-roadmap](./roadmap.md) for the exact line.

## Non-goals

- Not a general document editor (not Notion-pages, not a word processor).
- Not a real-time whiteboard or canvas.
- Not a mobile-native-first product (PWA is the target surface).

## Success criteria for V1

- A single user can work entirely offline for a day and have it sync cleanly.
- Two users editing the same document concurrently never see corruption or lost structure.
- Reordering/moving 10k-item outlines stays responsive.
- The whole thing self-hosts from a documented `docker compose` and a Postgres + S3.
