# ADR-0024 — Schema v2 tree interpretation, deletion and undo

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Agreed personal-first conflict contract

## Decision

Schema v2 stores atomic Yjs placement values without claiming HLC comparison
selects the winner. A causally later move supersedes the earlier placement;
concurrent moves converge by native Yjs semantics. HLC fields remain readable for
legacy archives, not as a second merge authority.

One pure effective-tree function interprets raw placements on both client and
server. Orphans attach to the root; each cycle is broken at its smallest item
UUID. Raw data is not rewritten. Recovered roots remain identifiable in this
view. The canonical document root cannot be moved or deleted through commands.

Deletes create unique records; restore acknowledges observed records. An unseen
concurrent delete remains effective, and editing does not restore an item.
Descendants still beneath a trashed ancestor remain hidden; explicitly moved-out
children survive. Structural undo emits new placements and delete/restore
intentions; text undo is locally scoped and preserves remote edits. Local zoom
and collapse preferences are account/document-scoped and are not document edits.
Automatic physical GC is disabled unless explicitly configured.

The schema handshake rejects incompatible clients. Previous browser caches are
preserved with a separate export action. The disposable outliner_test database
was exported to /workspace/scratch/personal-baseline.sql and restored into
outliner_export_check with matching counts (67 documents, 170 updates, 20301
items, 15 receipts) before its reset. No external/production data was reset.

This supersedes conflicting winner, cycle-repair and deletion behavior in
ADR-0008–0012 and 0019 without editing those accepted historical records.

## Evidence

personal-semantics.test.ts covers merge rules, 100 generated tree scenarios,
root invariants, delete/restore races, and local undo preserving remote content.
The Chromium offline suite includes structural undo/redo and reconnect behavior.
