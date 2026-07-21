# 09 — Attachments & Images

**Status:** Accepted · **Decision owner:** _TBD_ · **Last updated:** 2026-07-21

Attachments are large binary blobs referenced by items. They sync on the **blob plane** —
a different path from the CRDT structure/text plane — because binaries don't belong in a
CRDT. Mirrors report §"Attachments & Images (offline sync)".

## Decision summary

| Concern | Decision |
|---------|----------|
| Blob storage | **S3** (or S3-compatible: MinIO for self-host) |
| Blobs in the CRDT? | **No.** Yjs is for structured/text data, never megabyte binaries |
| Metadata | `attachments` table; items reference attachments by id |
| Offline capture | Store blob in **IndexedDB** (or OPFS for large files) + insert item immediately |
| Upload | **Deferred outbox** → presigned S3 PUT on reconnect |
| Download | Lazy presigned GET, cached in IndexedDB |
| Credentials | **Presigned URLs** only — S3 creds never reach the client |
| Deletion | Soft-delete with the item; GC removes the S3 object after retention |

## Model

```sql
CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_id       UUID REFERENCES items(id) ON DELETE SET NULL,
  s3_key        TEXT,                 -- null until upload completes
  mime          TEXT NOT NULL,
  size          BIGINT NOT NULL,
  checksum      TEXT NOT NULL,        -- content hash: dedup + integrity
  uploaded_at   TIMESTAMPTZ,          -- null while pending
  deleted_at    TIMESTAMPTZ
);
```

Items reference attachments **by id**. The blob itself never enters the Yjs doc.

## Offline capture → deferred upload

1. **Capture offline.** User adds an image/file with no network → store the blob in
   IndexedDB (or OPFS for large files) under a **client-generated attachment id**, and insert
   the referencing item immediately. The item is fully usable offline pointing at the local
   blob URL.
2. **Queue the upload.** Add to a persistent **outbox** of pending uploads.
3. **On reconnect** (Background Sync): upload each blob to S3 via **presigned PUT**, then
   write the `attachments` row (`s3_key`, `uploaded_at`) and **flip the item's reference**
   from the local blob URL to the `s3_key`. The client id is the durable key, so retries are
   idempotent. → [07-offline-and-pwa](./offline-and-pwa.md)

## Download on demand

When a peer receives an item referencing an attachment it doesn't have locally:

- Lazily fetch the blob from S3 via **presigned GET** and cache it in IndexedDB.
- **Don't block outline render** on blob availability — show a placeholder until fetched.

## Integrity, dedup, security

- **Content-hash (`checksum`)** every blob: dedup identical uploads, detect corruption.
- **Presigned URLs** keep S3 credentials off the client for both PUT and GET.
- Enforce **max size / allowed MIME** at the presign step (server decides what it will sign).

## Deletion

Attachment rows soft-delete alongside their item. The **S3 object is removed by the same
tombstone-aware GC** after the retention window — so an offline client that re-adds a
reference *during* the window doesn't hit a missing object.
→ [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)

## Why a separate plane

Putting a 5MB image into the Yjs doc would bloat every sync and every client's memory, and
CRDT merge semantics are meaningless for opaque binaries. Keeping blobs on their own path —
referenced by id, synced through the outbox, stored in S3 — keeps the CRDT plane small and
fast. → [01-architecture-overview](./architecture-overview.md) "three data planes"
