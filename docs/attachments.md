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

> **Canonical DDL:** the illustrative table above predates the integrity migration. The
> authoritative `attachments` definition — created with a **composite same-document FK
> `(item_id, document_id) → items(id, document_id) ON DELETE RESTRICT`** (not `SET NULL`) so a
> live attachment can't be orphaned or point cross-document — is
> [`/migrations/0002_integrity_v1.sql`](../migrations/0002_integrity_v1.sql). See
> [data-model.md](./data-model.md) for the invariants.

## Offline capture → deferred upload

1. **Capture offline.** User adds an image/file with no network → store the blob in
   IndexedDB (or OPFS for large files) under a **client-generated attachment id**, and insert
   the referencing item immediately. The item is fully usable offline pointing at the local
   blob URL.
2. **Queue the upload.** Add to a persistent **outbox** of pending uploads.
3. **On reconnect** (Background Sync): upload each blob to S3 via **presigned PUT**, then
   write the `attachments` row (`s3_key`, `uploaded_at`). The item's reference is the
   **client-generated attachment id and never changes** — the item points at the attachment
   *row*, not at a storage key. What changes is where that row's blob is *resolved from*: the
   client's local-blob-URL cache entry for that id is superseded by the row's `s3_key`. So the
   item reference is stable; only the attachment's own `s3_key` transitions from null → set.
   The client id is the durable key, so retries are idempotent. → [07-offline-and-pwa](./offline-and-pwa.md)

## Download on demand

When a peer receives an item referencing an attachment it doesn't have locally:

- Lazily fetch the blob from S3 via **presigned GET** and cache it in IndexedDB.
- **Don't block outline render** on blob availability — show a placeholder until fetched.

## Integrity, dedup, security

Upload finalization is **server-verified, not client-asserted.** The client proposes
`mime`/`size`/`checksum` at presign time, but the server MUST NOT trust them as the row of
record:

- **Content-hash (`checksum`)** every blob to dedup identical uploads and detect corruption.
  The **server computes the checksum from the stored S3 object** (or requires S3 to, e.g. via
  `x-amz-checksum-*`) on finalize and rejects a mismatch against what the client claimed. The
  persisted `attachments.checksum` is the server-computed value.
- **Size and MIME** are **verified server-side** against the actual stored object on finalize,
  not taken from the client. The presign step enforces a max size and an allowed-MIME list
  (`content-length-range` / `Content-Type` conditions in the presigned POST policy) so the
  client physically cannot store an object outside those bounds.
- **`s3_key` is server-assigned**, derived from `document_id` + attachment id — the client does
  not choose the storage key, so it cannot overwrite another tenant's object or collide.
- **Presigned URLs** keep S3 credentials off the client for both PUT and GET. Only the server
  flips `uploaded_at` (marking the row finalized) after these checks pass.

## Deletion & presign policy (decided)

- **Presign TTLs are short.** PUT presigns ~5 min, GET presigns ~15 min — long enough for an
  upload/download, short enough that a presign minted just before a member is revoked expires on
  its own rather than granting lasting access ([ADR-0014](./adr/0014-session-auth-and-revocation.md)).
  Presign **issuance checks live membership**, so a revoked user cannot mint new URLs.
- **Deferred S3 GC.** Attachment rows soft-delete alongside their item. On item hard-delete, the
  tombstone-aware GC **detaches / soft-deletes the attachment rows first, then removes the S3
  object after the retention window** — so an offline client that re-adds a reference *during*
  the window doesn't hit a missing object, and the `attachments` RESTRICT FK (migration
  `0002_integrity_v1.sql`) structurally prevents deleting an item out from under a live
  attachment row. Immediate S3 deletion is explicitly **not** done: it would race offline undo
  (a resurrected item losing its blob). → [ADR-0006](./adr/0006-soft-delete-and-tombstone-gc.md)

## Why a separate plane

Putting a 5MB image into the Yjs doc would bloat every sync and every client's memory, and
CRDT merge semantics are meaningless for opaque binaries. Keeping blobs on their own path —
referenced by id, synced through the outbox, stored in S3 — keeps the CRDT plane small and
fast. → [01-architecture-overview](./architecture-overview.md) "three data planes"
