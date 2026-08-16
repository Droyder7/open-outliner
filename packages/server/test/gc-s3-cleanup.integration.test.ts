import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace } from '../src/db/tenancy-repo.js';
import { createAttachment, finalizeAttachment } from '../src/db/attachments-repo.js';
import { createS3Service, type S3Service } from '../src/storage/s3.js';
import { createGcWorker } from '../src/jobs/gc.js';

/**
 * GC attachment S3 cleanup (ADR-0006 attachment path, GC row "integration test
 * for S3 object cleanup").
 *
 * Delete path under test: GC soft-deletes the attachment row BEFORE it can
 * hard-delete the parent item row (the `attachments.item_id` FK is RESTRICT),
 * then — after the attachment's OWN retention window — removes the S3 object
 * and nulls `s3_key` (deferred blob GC, avoids the offline-undo race).
 *
 * These tests need real Postgres AND a reachable S3/MinIO (the CI integration
 * job wires both); they skip when either is unset.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION ?? 'us-east-1';

const hasS3 =
  !!S3_ENDPOINT && !!S3_ACCESS_KEY_ID && !!S3_SECRET_ACCESS_KEY && !!S3_BUCKET;
const describeDb = DATABASE_URL && hasS3 ? describe : describe.skip;

/** How old a soft-deleted attachment must be to be past a given retention floor. */
const DAY = 86_400_000;

describeDb('GC attachment S3 cleanup (ADR-0006)', () => {
  let db: Db;
  let s3: S3Service;
  let raw: S3Client;
  const config = loadConfig();
  const createdKeys: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);

    const s3Config = {
      endpoint: S3_ENDPOINT!,
      region: S3_REGION,
      bucket: S3_BUCKET!,
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!,
      forcePathStyle: true,
    };
    s3 = createS3Service(s3Config);
    raw = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true,
    });
    // MinIO does not auto-create buckets; make the shared CI bucket idempotently.
    try {
      await raw.send(new CreateBucketCommand({ Bucket: s3Config.bucket }));
    } catch (err: unknown) {
      const name =
        typeof err === 'object' && err !== null && 'name' in err
          ? String((err as { name: unknown }).name)
          : '';
      const status =
        typeof err === 'object' && err !== null && '$metadata' in err
          ? (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode
          : undefined;
      if (!(name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists' || status === 409)) {
        throw err;
      }
    }
  });

  afterAll(async () => {
    if (raw && createdKeys.length > 0) {
      await raw
        .send(
          new DeleteObjectsCommand({
            Bucket: S3_BUCKET!,
            Delete: { Objects: createdKeys.map((Key) => ({ Key })) },
          }),
        )
        .catch(() => {});
    }
    if (db) await db.close();
  });

  /** Fresh document (no items yet) + its root item. */
  async function freshDocument(): Promise<{ documentId: string; rootId: string }> {
    const ownerId = await createUser(db, `u-${randomUUID()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'WS');
    const doc = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ($1, 'Doc') RETURNING id`,
      [workspaceId],
    );
    const documentId = doc.rows[0]!.id;
    const rootId = randomUUID();
    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content)
       VALUES ($1, $2, NULL, 'a', 'bullet', '')`,
      [rootId, documentId],
    );
    return { documentId, rootId };
  }

  /**
   * Seed an item with a REAL S3 object: an `attachments` row finalized with the
   * canonical s3_key and the blob actually present in the bucket.
   */
  async function itemWithAttachment(
    documentId: string,
    rootId: string,
  ): Promise<{ itemId: string; attachmentId: string; s3Key: string }> {
    const itemId = randomUUID();
    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content, deleted_at)
       VALUES ($1, $2, $3, 'a0', 'bullet', 'attached', $4)`,
      [itemId, documentId, rootId, new Date(Date.now() - 2 * DAY)],
    );
    const attachmentId = await createAttachment(db, documentId, itemId, 'text/plain', 5);
    const s3Key = s3.s3Key(documentId, attachmentId);
    await finalizeAttachment(db, attachmentId, documentId, s3Key, 5, 'abc123');
    await raw.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET!,
        Key: s3Key,
        Body: Buffer.from('hello'),
        ContentType: 'text/plain',
      }),
    );
    createdKeys.push(s3Key);
    return { itemId, attachmentId, s3Key };
  }

  async function attachmentRow(attachmentId: string): Promise<{
    deleted_at: Date | null;
    s3_key: string | null;
  }> {
    const res = await db.query<{ deleted_at: Date | null; s3_key: string | null }>(
      `SELECT deleted_at, s3_key FROM attachments WHERE id = $1`,
      [attachmentId],
    );
    return res.rows[0]!;
  }

  async function itemIds(documentId: string): Promise<string[]> {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM items WHERE document_id = $1 ORDER BY id`,
      [documentId],
    );
    return res.rows.map((r) => r.id);
  }

  /** Backdate an attachment's soft-delete so it clears a given retention floor. */
  async function backdateSoftDelete(attachmentId: string, daysAgo: number): Promise<void> {
    await db.query(`UPDATE attachments SET deleted_at = now() - $2::interval WHERE id = $1`, [
      attachmentId,
      `${daysAgo} days`,
    ]);
  }

  it('defers S3 deletion until the attachment soft-delete is past its own retention window', async () => {
    const { documentId, rootId } = await freshDocument();
    const { itemId, attachmentId, s3Key } = await itemWithAttachment(documentId, rootId);
    // Pin the item's tombstone within the retention floor so THIS test exercises
    // only the attachment deferral — the item must not be hard-deleted yet.
    await db.query(`UPDATE items SET deleted_at = now() WHERE id = $1`, [itemId]);
    // Soft-delete the attachment now (as GC would once the item is eligible).
    await db.query(`UPDATE attachments SET deleted_at = now() WHERE id = $1`, [attachmentId]);

    // retentionMs = 2 days, soft-deleted 1 day ago → NOT past the window yet.
    await backdateSoftDelete(attachmentId, 1);
    await createGcWorker(db, { retentionMs: 2 * DAY, batchSize: 100 }, s3).run();

    expect(await itemIds(documentId)).toContain(itemId); // item untouched (not this test's target)
    const fresh = await attachmentRow(attachmentId);
    expect(fresh.s3_key).toBe(s3Key);
    expect(await s3.headObject(s3Key)).not.toBeNull();

    // Soft-deleted 3 days ago → past the 2-day window → object removed + key nulled.
    await backdateSoftDelete(attachmentId, 3);
    await createGcWorker(db, { retentionMs: 2 * DAY, batchSize: 100 }, s3).run();

    expect(await s3.headObject(s3Key)).toBeNull();
    const cleared = await attachmentRow(attachmentId);
    expect(cleared.s3_key).toBeNull();
    expect(cleared.deleted_at).not.toBeNull();
  });

  it('soft-deletes the attachment before hard-deleting the item, then cleans the object on a later pass', async () => {
    const { documentId, rootId } = await freshDocument();
    const { itemId, attachmentId, s3Key } = await itemWithAttachment(documentId, rootId);

    // Pass 1 WITHOUT S3 wiring: the item row must still be hard-deleted (the
    // attachment FK was soft-deleted first) and the blob must survive untouched.
    await createGcWorker(db, { retentionMs: 0, batchSize: 100 }).run();

    expect(await itemIds(documentId)).toEqual([rootId]);
    expect((await itemIds(documentId)).includes(itemId)).toBe(false);
    const softDeleted = await attachmentRow(attachmentId);
    expect(softDeleted.deleted_at).not.toBeNull();
    expect(softDeleted.s3_key).toBe(s3Key); // deferred — blob GC runs on its own window
    expect(await s3.headObject(s3Key)).not.toBeNull();

    // Pass 2 with S3 wiring, once the soft-delete is past retention: blob gone, key nulled.
    await backdateSoftDelete(attachmentId, 1);
    await createGcWorker(db, { retentionMs: 0, batchSize: 100 }, s3).run();

    expect(await s3.headObject(s3Key)).toBeNull();
    expect((await attachmentRow(attachmentId)).s3_key).toBeNull();
  });

  it('keeps the s3_key and retries when the S3 delete fails (best-effort, next pass)', async () => {
    const { documentId, rootId } = await freshDocument();
    const { attachmentId, s3Key } = await itemWithAttachment(documentId, rootId);
    await db.query(`UPDATE attachments SET deleted_at = now() - interval '3 days' WHERE id = $1`, [
      attachmentId,
    ]);

    let failNext = true;
    const flaky: S3Service = {
      ...s3,
      deleteObject: async (key) => {
        if (failNext) {
          failNext = false;
          throw new Error('s3 unavailable');
        }
        await s3.deleteObject(key);
      },
    };

    await createGcWorker(db, { retentionMs: 0, batchSize: 100 }, flaky).run();
    expect((await attachmentRow(attachmentId)).s3_key).toBe(s3Key); // row retains the key
    expect(await s3.headObject(s3Key)).not.toBeNull(); // object still in the bucket

    await createGcWorker(db, { retentionMs: 0, batchSize: 100 }, flaky).run();
    expect(await s3.headObject(s3Key)).toBeNull();
    expect((await attachmentRow(attachmentId)).s3_key).toBeNull();
  });
});
