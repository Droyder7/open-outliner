# ADR-0007 — Attachments on a separate S3 blob plane

**Status:** Accepted · **Date:** 2026-07-21 · **Deciders:** _TBD_

## Context

Users attach images and files to items. The naive approach is to put the binary into the Yjs
document alongside the item. But CRDTs are for structured/text data — a multi-megabyte blob
would bloat every sync and every client's memory, and CRDT merge semantics are meaningless
for opaque binaries. Attachments also need to work offline (capture with no network) and sync
reliably on reconnect.

## Decision

Attachments live on a **separate blob plane**: stored in **S3** (S3-compatible MinIO for
self-host), described by an `attachments` metadata row, and **referenced by items via id**.
**Blobs never enter the Yjs doc.** Offline capture stores the blob in IndexedDB (or OPFS for
large files) with a client-generated id and a **deferred upload outbox**; uploads/downloads
use **presigned URLs**.

## Consequences

- **Easier:** the CRDT plane stays small and fast; sync payloads don't carry binaries; S3
  gives a natural CDN/self-host path; presigned URLs keep S3 credentials off the client.
- **Newly required:** an upload outbox with idempotent, Background-Sync-driven retry;
  reference-flipping from local blob URL to `s3_key` on upload; lazy download-on-demand with a
  placeholder while fetching; content-hash (`checksum`) for dedup + integrity; presign-time
  enforcement of max size / allowed MIME.
- **Deletion:** attachment rows soft-delete with their item; the S3 object is removed by the
  same tombstone-aware GC (ADR-0006) after the retention window, so an offline client
  re-adding a reference during the window doesn't hit a missing object.
- The `attachments` FK to `items` uses `ON DELETE SET NULL`/soft-delete semantics rather than
  cascade, consistent with the no-cascade rule.

## Alternatives considered

- **Blobs inside the Yjs doc:** bloats sync and memory; meaningless merge semantics for
  binaries. Rejected.
- **Blobs in Postgres (`bytea`/large objects):** bloats the DB, no CDN path, expensive
  backups. Rejected in favor of S3.
- **Direct client→S3 with static credentials:** leaks credentials. Presigned URLs instead.
