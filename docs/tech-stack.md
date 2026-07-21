# 02 — Tech Stack

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

This is **Pattern 1** from the research report — the strongest OSS-aligned end-to-end
stack. Each row records the choice and the main alternative we rejected.

## The stack

| Layer | Choice | Why | Rejected alternative |
|-------|--------|-----|----------------------|
| **Client framework** | React + TypeScript + **Vite** | Richest ecosystem for TipTap + Yjs + PWA tooling | Vue/Svelte/Solid — fine, but thinner collab/editor ecosystem |
| **Rich text / editor** | **TipTap** (ProseMirror) bound to Yjs | Battle-tested Yjs binding, block-friendly | Slate, Lexical — weaker Yjs story at decision time |
| **Collab / CRDT** | **Yjs** | De-facto standard for collaborative editors; text + tree | Automerge (heavier), OT (harder move semantics) |
| **Realtime transport** | **Hocuspocus** (Yjs WS server) | Turnkey Yjs server with hooks for persistence + projection | Custom WS service — more control, more to build |
| **Local persistence** | **IndexedDB** via Dexie / `y-indexeddb` | Durable local store; Yjs has a first-class provider | OPFS/SQLite-wasm — reserved for large blobs only |
| **PWA plumbing** | Service worker via **Workbox / vite-plugin-pwa** | Precache + runtime caching + background sync | Hand-rolled SW — error-prone |
| **Backend runtime** | **Node.js + TypeScript** | Shares types/CRDT code with client; matches dev profile | Go/Rust — fast, but splits the Yjs story |
| **Database** | **PostgreSQL** | Recursive CTEs, `ltree`, GIN/FTS, `COLLATE "C"` — everything the model needs | MySQL (weaker recursive/`ltree`), Mongo (no relational views) |
| **Blob storage** | **S3** (or S3-compatible: MinIO) | Standard, self-hostable, presigned URLs | DB blobs — bloats Postgres, no CDN path |
| **Auth** | Sessions or JWT at the API/WS edge | Standard; presence/permissions layered on top | Firebase Auth — pulls in a hosted dependency |

## Why this pattern over the others

The report weighed three end-to-end patterns:

- **Pattern 1 — PWA + Yjs + Node/Postgres (chosen).** Strongest OSS alignment, full control
  of the data plane, proven in Google-Docs-style clones. We own presence, awareness, and
  permissions — accepted cost.
- **Pattern 2 — Local-first DB engine (Replicache/ElectricSQL/PowerSync/Jazz).** Lovely
  offline semantics and a simpler mutation/query API, but less proven for *complex tree /
  outline* editors, and several are younger/less standard. Reassess for a future version if
  we want more DB-like sync semantics. → [ADR-0002](./adr/0002-sync-engine-yjs-vs-localfirst.md)
- **Pattern 3 — Next.js + Supabase + Yjs.** Fastest iteration, but leans on hosted Supabase
  and dilutes the "own your data / self-host" principle.

Yjs is simply the most standard choice in the collaborative-editor niche; picking it
minimizes integration friction across the editor, transport, and offline layers at once.

## Notable specifics

- **`COLLATE "C"`** on the `rank` column is mandatory, not incidental — fractional indexing
  depends on byte-wise lexicographic ordering. → [05-fractional-indexing](./fractional-indexing.md)
- **Next.js is optional** and only for marketing/auth pages needing SSR; the app itself is
  a Vite SPA/PWA.
- **MinIO** is the recommended S3 for self-hosters so the blob plane has no cloud dependency.

## Deferred / reassess-later

- Native mobile shells (Capacitor/Expo) — only if PWA limits bite.
- A local-first sync engine (Pattern 2) — revisit if Yjs persistence/permissions design
  cost outgrows its benefit.
- SQLite-in-browser as the primary local store — IndexedDB is enough for V1.
