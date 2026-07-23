import { randomUUID } from 'node:crypto';
import type { Db, TxClient } from './db.js';

/**
 * Database queries for the `attachments` table (blob-plane metadata).
 * The `attachments` table is defined in migrations/0002_integrity_v1.sql.
 *
 * The item_id/document_id composite FK (ON DELETE RESTRICT) means GC MUST
 * soft-delete attachments before it can hard-delete the parent item row.
 */

export interface AttachmentRow {
  id: string;
  document_id: string;
  item_id: string | null;
  s3_key: string | null;
  mime: string;
  size: number;
  checksum: string;
  uploaded_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
}

/** Create a pending attachment row (before upload completes). */
export async function createAttachment(
  db: Db,
  documentId: string,
  itemId: string | null,
  mime: string,
  size: number,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO attachments (id, document_id, item_id, mime, size, checksum)
     VALUES ($1, $2, $3, $4, $5, '')`,
    [id, documentId, itemId, mime, size],
  );
  return id;
}

/** Finalize an attachment after server-side verification: set s3_key, size, checksum, uploaded_at. */
export async function finalizeAttachment(
  db: Db,
  attachmentId: string,
  documentId: string,
  s3Key: string,
  size: number,
  checksum: string,
): Promise<AttachmentRow | null> {
  const res = await db.query<AttachmentRow>(
    `UPDATE attachments
        SET s3_key = $3, size = $4, checksum = $5, uploaded_at = now()
      WHERE id = $1 AND document_id = $2 AND uploaded_at IS NULL AND deleted_at IS NULL
      RETURNING *`,
    [attachmentId, documentId, s3Key, size, checksum],
  );
  return res.rows[0] ?? null;
}

export async function getAttachmentById(
  db: Db,
  attachmentId: string,
  documentId: string,
): Promise<AttachmentRow | null> {
  const res = await db.query<AttachmentRow>(
    `SELECT * FROM attachments WHERE id = $1 AND document_id = $2 AND deleted_at IS NULL`,
    [attachmentId, documentId],
  );
  return res.rows[0] ?? null;
}

/** Find a live attachment by document + id, regardless of uploaded state. */
export async function getAttachmentForDownload(
  db: Db,
  attachmentId: string,
  documentId: string,
): Promise<AttachmentRow | null> {
  const res = await db.query<AttachmentRow>(
    `SELECT * FROM attachments
      WHERE id = $1 AND document_id = $2 AND uploaded_at IS NOT NULL AND deleted_at IS NULL`,
    [attachmentId, documentId],
  );
  return res.rows[0] ?? null;
}

/** Soft-delete all live attachments for the given item (called before item GC). */
export async function softDeleteAttachmentsForItem(
  tx: TxClient,
  documentId: string,
  itemId: string,
): Promise<string[]> {
  const res = await tx.query<{ id: string; s3_key: string | null }>(
    `UPDATE attachments
        SET deleted_at = now()
      WHERE document_id = $1 AND item_id = $2 AND deleted_at IS NULL
      RETURNING id, s3_key`,
    [documentId, itemId],
  );
  return res.rows.map((r) => r.id);
}

/**
 * Find attachments soft-deleted before the retention cutoff that still have
 * an S3 object to clean up — used by the GC worker to schedule blob deletion.
 */
export async function getPendingS3Deletions(
  db: Db,
  cutoff: Date,
  limit = 500,
): Promise<{ id: string; document_id: string; s3_key: string }[]> {
  const res = await db.query<{ id: string; document_id: string; s3_key: string }>(
    `SELECT id, document_id, s3_key FROM attachments
      WHERE deleted_at IS NOT NULL AND deleted_at < $1 AND s3_key IS NOT NULL
      ORDER BY deleted_at
      LIMIT $2`,
    [cutoff, limit],
  );
  return res.rows;
}

/** Null out s3_key after the blob has been deleted from S3. */
export async function clearS3Key(db: Db, attachmentId: string): Promise<void> {
  await db.query(`UPDATE attachments SET s3_key = NULL WHERE id = $1`, [attachmentId]);
}

/** Count soft-deleted attachments still awaiting S3 GC (OPS backlog metric). */
export async function gcBacklogCount(db: Db): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM attachments WHERE deleted_at IS NOT NULL AND s3_key IS NOT NULL`,
  );
  return Number.parseInt(res.rows[0]?.n ?? '0', 10);
}
