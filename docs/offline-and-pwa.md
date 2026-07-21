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
- **Search index (V2, optional)** — a built client-side inverted index. V1 offline search is a
  naive in-memory filter over loaded items, no persisted index. → [08-search](./search.md)

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

## When local storage fails (required behavior)

Product principle #1 says "every write MUST succeed locally," but browser storage can and does
fail — that promise is only implementable if failure has defined behavior, not if it is assumed
away. The contract:

- **Quota exhaustion / eviction.** Writes to `y-indexeddb` or the outbox that fail with a quota
  error MUST surface a non-destructive "storage full — free space or some offline edits may not
  persist" state, never a silent drop. The in-memory Yjs doc keeps working; the risk is durability
  across reload, and the user must be told.
- **Private browsing / IndexedDB unavailable.** Detect at startup; fall back to in-memory-only
  operation with an explicit "changes won't survive a reload" banner rather than pretending
  persistence exists.
- **Failed IndexedDB transaction.** Retry with backoff; if it keeps failing, treat as the
  quota/unavailable case above — surface, don't swallow.
- **Local corruption.** A `y-indexeddb` store that fails to load is rebuilt from the server on
  next connect; if offline, start a fresh in-memory doc and warn that unsynced local edits may
  be unrecoverable. Never hard-crash the app on a corrupt store.
- **Background Sync absent** (Safari/Firefox): fall back to a foreground reconnect flush on
  `online` / visibility events — Background Sync is an optimization, not a requirement.
- **Service-worker upgrade.** A new SW version MUST NOT drop a non-empty mutation outbox or the
  Yjs store; migrate or preserve across `activate`, and never `skipWaiting` in a way that
  discards pending writes.

"Every write succeeds locally" holds for the **in-memory Yjs doc**; **durability** is
best-effort with the honest, surfaced failure states above. Track under `OFF` in
[status.md](./status.md) — this behavior is required for V1, not deferred.

**Offline access loss is a server-side rejection, not a local promise.** "Every write succeeds
locally" is about *durability*, not *authority*. A client that edited offline and then lost
access (removed from the workspace) has its queued Yjs updates and outbox writes **rejected
server-side on reconnect** — the killable server session is re-resolved at the Hocuspocus
`onAuthenticate` reconnect check ([ADR-0014](./adr/0014-session-auth-and-revocation.md)), so a
revoked replay never merges. The local edits stay usable until then and the cache is best-effort
purged on next failed auth, but the security boundary is the **server rejecting the replay**.
→ [11-security-and-multitenancy](./security-and-multitenancy.md)

## Deferred

- Native shells (Capacitor/Expo) — only if PWA platform limits (push, file handling) bite.
- Full SQLite-in-browser local store — IndexedDB is sufficient for V1.
