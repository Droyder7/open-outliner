# 07 — Offline & PWA

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

Product principle #1: **offline-first, not offline-tolerant.** Every write MUST succeed
locally with no network; sync is background reconciliation.

## Decision summary

| Concern | Choice |
|---------|--------|
| Primary client | React/Vite **PWA** installable on desktop + mobile |
| Local persistence | **IndexedDB** via Dexie + `y-indexeddb` provider |
| Service worker | **Workbox / vite-plugin-pwa** — precache + runtime caching |
| Failed-write retry | **Background Sync** + a durable mutation queue |
| Structure/text offline | Yjs doc persisted locally; edits apply immediately |
| Attachments offline | Local blob store + deferred upload outbox → [09-attachments](./attachments.md) |

## How offline works

Because the **Yjs document is the client's source of truth** (not a server response), the
app doesn't need the network to function:

1. **Edits mutate the local Yjs doc** and render instantly. `y-indexeddb` persists the doc
   to IndexedDB, so a reload while offline loses nothing.
2. **Ops queue for sync.** While disconnected, Yjs updates accumulate locally; on reconnect
   the provider syncs them with Hocuspocus and merges bidirectionally (CRDT convergence — no
   conflicts to resolve by hand). → [04-sync](./sync-and-conflict-resolution.md)
3. **API-plane mutations** (things that aren't CRDT structure/text — e.g. attachment
   metadata, workspace settings) go through a **durable mutation queue**: a local outbox of
   intended writes, replayed with **Background Sync** when the network returns. Each carries a
   client-generated id so retries are idempotent.

## Local storage layout (IndexedDB)

- **Yjs doc state** — via `y-indexeddb`, per document. The working set of structure + text.
- **Mutation outbox** — pending API writes not yet acknowledged by the server.
- **Attachment blob cache** — captured-offline blobs and lazily-fetched attachment blobs,
  keyed by attachment id. Large files MAY use OPFS instead. → [09-attachments](./attachments.md)
- **Search index (optional)** — a small client-side inverted index for offline search.
  → [08-search](./search.md)

## Service worker responsibilities

- **Precache** the app shell (Workbox) so the PWA cold-starts offline.
- **Runtime caching** for static assets and safe GET endpoints.
- **Background Sync** to retry queued mutations and attachment uploads on reconnect.
- Do **not** cache the CRDT sync transport through the SW — Yjs/Hocuspocus manage their own
  offline/reconnect; the SW handles HTTP, not the WebSocket CRDT plane.

## What "a day offline" looks like (success criterion)

A user edits, reorders, moves, tags, and adds an image entirely offline. Everything is
immediate and durable across reloads. On reconnect:

- Yjs structure/text merges cleanly with any concurrent edits from other devices.
- Queued API mutations replay idempotently.
- Offline-captured image blobs upload from the outbox; item references flip from local blob
  URLs to `s3_key`.
- No corruption, no lost structure, no manual merge.

## Deferred

- Native shells (Capacitor/Expo) — only if PWA platform limits (push, file handling) bite.
- Full SQLite-in-browser local store — IndexedDB is sufficient for V1.
