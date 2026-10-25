# ADR-0025 — Local retrieval and portable recovery

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Approved personal-first delivery plan

## Context

A dependable personal outline needs capture, retrieval, and recovery without
requiring a reachable server or replacing the current working document.

## Decision

Title, text, notes and completion belong to the Yjs document. The account-scoped
local catalog mirrors titles, and a debounced local index searches cached item
text and notes. Results open the document and reveal hidden ancestors. View
preferences remain local. Trash has explicit observed-token restore actions.

Device-local raw Yjs checkpoints are saved on demand and every five minutes of
changes. Imports and pre-versioned cache conversion get a prior checkpoint.
History recovery creates a fresh document; it never rolls back the active one.
Checkpoints are retained indefinitely and are not a substitute for exported or
server backups. Search entries and checkpoints remain account-scoped.

Portable JSON version 2 includes a canonical root, effective hierarchy, sibling
order, plain content, notes and completion. Ordinary exports omit trash; recovery
retains trash. Validate the entire input before writing, reject missing parents,
cycles and malformed entries, and create fresh identities and canonical ranks.
Commit the new catalog entry and its pending Yjs state atomically. Markdown is a
readable export; JSON is the round-trip format. Earlier server export contracts
remain available for legacy data; the personal workflow uses this v2 format.

## Consequences

Search covers content cached on this device. Checkpoints consume local storage;
quota failures are surfaced. Recovery preserves content and structure, rather
than reusing CRDT identities or erasing subsequent edits. A new browser/device
requires synced documents or an import; checkpoints are not yet replicated.
