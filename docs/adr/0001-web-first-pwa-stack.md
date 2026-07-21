# ADR-0001 — Web-first PWA + Yjs + Node/Postgres stack (Pattern 1)

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

We're building an open-source, offline-first, real-time collaborative outliner. The driving
developer profile is backend-heavy (Node.js, PostgreSQL, cloud), web-first. The research
report weighed three end-to-end patterns: (1) PWA + Yjs + Node/Postgres, (2) a local-first
DB engine, (3) Next.js + Supabase + Yjs.

## Decision

Adopt **Pattern 1**: a React/Vite **PWA** client, **Yjs** CRDT over WebSockets via
**Hocuspocus**, a **Node.js/TypeScript** backend, **PostgreSQL** for the queryable
projection, and **S3** for blobs. TipTap is the rich-text editor bound to Yjs. IndexedDB is
the local store; Workbox/vite-plugin-pwa provides the service worker.

## Consequences

- **Easier:** full control of the data plane; strongest OSS/self-host alignment; one
  TypeScript codebase can share types and CRDT logic client↔server; proven combination in
  Google-Docs-style collaborative apps.
- **Harder / newly required:** we own presence, awareness, and permission logic ourselves
  (no hosted realtime DB doing it for us); we must design the CRDT persistence + projection
  layer (see ADR-0004).
- Self-hosting stays to Postgres + S3 (MinIO) + Node services — no hosted dependency on the
  critical path.

## Alternatives considered

- **Pattern 2 — local-first DB engine (Replicache/ElectricSQL/PowerSync/Jazz):** great
  offline semantics and a simpler mutation/query API, but less proven for complex tree/
  outline editors; several are younger/less standard. See ADR-0002.
- **Pattern 3 — Next.js + Supabase + Yjs:** fastest iteration but leans on hosted Supabase,
  diluting the "own your data" principle.
- **Heavier/other frontends (Vue/Svelte/Solid):** fine, but thinner ecosystem around
  TipTap + Yjs + PWA tooling, increasing integration friction.
