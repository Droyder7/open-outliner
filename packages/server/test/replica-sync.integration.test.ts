import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace } from '../src/db/tenancy-repo.js';
import {
  touchReplica,
  hasUnsyncedReplicaPast,
  pruneStaleReplicas,
} from '../src/db/replica-sync-repo.js';
import { createGcWorker } from '../src/jobs/gc.js';

// These tests require a live Postgres (DATABASE_URL). They are skipped when it is
// unset so the suite stays green in environments without a database.
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('replica_sync ledger + GC replica-ack gating (ADR-0019)', () => {
  let db: Db;
  const config = loadConfig();

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  /** Fresh document row (no items yet) + its root item. */
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

  /** Insert a tombstoned leaf (child of root) with an explicit deleted_at. */
  async function insertTombstone(
    documentId: string,
    rootId: string,
    deletedAt: Date,
    id = randomUUID(),
  ): Promise<string> {
    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content, deleted_at)
       VALUES ($1, $2, $3, 'a0', 'bullet', '', $4)`,
      [id, documentId, rootId, deletedAt],
    );
    return id;
  }

  async function itemIds(documentId: string): Promise<string[]> {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM items WHERE document_id = $1 ORDER BY id`,
      [documentId],
    );
    return res.rows.map((r) => r.id);
  }

  const twoDaysAgo = () => new Date(Date.now() - 2 * 86_400_000); // tombstone
  const threeDaysAgo = () => new Date(Date.now() - 3 * 86_400_000); // synced BEFORE tombstone
  const oneDayAgo = () => new Date(Date.now() - 86_400_000); // synced AFTER tombstone
  const sixHoursAgo = () => new Date(Date.now() - 6 * 3_600_000); // seen recently
  const thirtyDaysAgo = () => new Date(Date.now() - 30 * 86_400_000); // stale past any TTL

  describe('touchReplica / hasUnsyncedReplicaPast', () => {
    it('an unsynced touch records liveness but leaves last_synced_at NULL (blocks GC)', async () => {
      const { documentId } = await freshDocument();
      await touchReplica(
        db,
        { documentId, replicaId: 'r1', synced: false },
        twoDaysAgo(),
      );
      const row = await db.query(
        `SELECT last_synced_at, last_seen_at FROM replica_sync WHERE document_id = $1`,
        [documentId],
      );
      expect(row.rows[0]!.last_synced_at).toBeNull();
      expect(row.rows[0]!.last_seen_at).not.toBeNull();

      expect(await hasUnsyncedReplicaPast(db, documentId, twoDaysAgo())).toBe(true);
    });

    it('a synced touch advances last_synced_at; a later unsynced touch cannot regress it', async () => {
      const { documentId } = await freshDocument();
      const t1 = threeDaysAgo();
      const t2 = twoDaysAgo();
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, t1);
      // Reconnect with a delayed sync-complete (older wall clock): must NOT regress.
      await touchReplica(db, { documentId, replicaId: 'r1', synced: false }, t2);
      const row = await db.query(
        `SELECT last_synced_at FROM replica_sync WHERE document_id = $1 AND replica_id = 'r1'`,
        [documentId],
      );
      expect(new Date(row.rows[0]!.last_synced_at).getTime()).toBe(t1.getTime());
    });

    it('a stale SYNCED touch (older wall clock) cannot regress last_synced_at either', async () => {
      const { documentId } = await freshDocument();
      const t1 = oneDayAgo();
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, t1);
      // A late/replayed ack with an older clock must not move the marker back.
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, threeDaysAgo());
      const row = await db.query(
        `SELECT last_synced_at FROM replica_sync WHERE document_id = $1 AND replica_id = 'r1'`,
        [documentId],
      );
      expect(new Date(row.rows[0]!.last_synced_at).getTime()).toBe(t1.getTime());
    });

    it('hasUnsyncedReplicaPast reflects the "every replica synced PAST since" bound', async () => {
      const { documentId } = await freshDocument();
      const t = twoDaysAgo();

      // No known replicas → nothing can resurrect → not blocked.
      expect(await hasUnsyncedReplicaPast(db, documentId, t)).toBe(false);

      // Replica synced before the tombstone → blocked.
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, threeDaysAgo());
      expect(await hasUnsyncedReplicaPast(db, documentId, t)).toBe(true);

      // Second replica synced after the tombstone → still blocked (ANY replica blocks).
      await touchReplica(db, { documentId, replicaId: 'r2', synced: true }, oneDayAgo());
      expect(await hasUnsyncedReplicaPast(db, documentId, t)).toBe(true);

      // First replica finally acks past the tombstone → unblocked.
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, oneDayAgo());
      expect(await hasUnsyncedReplicaPast(db, documentId, t)).toBe(false);
    });
  });

  describe('GC replica-ack gating', () => {
    async function runGc(): Promise<number> {
      const worker = createGcWorker(db, { retentionMs: 0, batchSize: 100 });
      return worker.run();
    }

    it('hard-deletes a tombstone past retention when no replicas are known', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());

      await runGc();

      expect(await itemIds(documentId)).toEqual([rootId]);
      expect((await itemIds(documentId)).includes(leafId)).toBe(false);
    });

    it('blocks hard-delete while ANY known replica has not synced past the tombstone', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'offline', synced: true }, threeDaysAgo());

      await runGc();

      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, leafId]));
    });

    it('blocks hard-delete when a replica last synced EXACTLY at the tombstone time (<= gate)', async () => {
      const { documentId, rootId } = await freshDocument();
      const t = twoDaysAgo();
      const leafId = await insertTombstone(documentId, rootId, t);
      // Synced at the same instant the tombstone was projected: it may not have
      // received it, so the gate must keep blocking.
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, t);

      await runGc();

      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, leafId]));
    });

    it('gates per tombstone within one document (a blocked leaf does not hold back an unblocked leaf)', async () => {
      const { documentId, rootId } = await freshDocument();
      // Tombstone A is OLDER (3d ago); tombstone B is NEWER (2d ago). The replica
      // synced BETWEEN them (2.5d ago): it synced past A (has it — unblocked) but
      // NOT past B (may still be missing it — blocked).
      const unblockedLeaf = await insertTombstone(documentId, rootId, threeDaysAgo());
      const blockedLeaf = await insertTombstone(documentId, rootId, twoDaysAgo());
      const between = new Date(Date.now() - 2.5 * 86_400_000);
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, between);

      await runGc();

      const remaining = await itemIds(documentId);
      expect(remaining).toContain(rootId);
      expect(remaining).toContain(blockedLeaf);
      expect(remaining).not.toContain(unblockedLeaf);
    });

    it('blocks hard-delete for a known replica that has never completed a sync (NULL)', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'mid-sync', synced: false }, twoDaysAgo());

      await runGc();

      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, leafId]));
    });

    it('hard-deletes once every replica has synced past the tombstone', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, oneDayAgo());

      await runGc();

      expect(await itemIds(documentId)).toEqual([rootId]);
      expect((await itemIds(documentId)).includes(leafId)).toBe(false);
    });

    it('a replica that acks after the tombstone (heartbeat/stateless ack) unblocks GC', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, threeDaysAgo());

      await runGc();
      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, leafId]));

      // The replica completes a sync now → last_synced_at jumps past the tombstone.
      await touchReplica(db, { documentId, replicaId: 'r1', synced: true }, new Date());
      await runGc();

      expect(await itemIds(documentId)).toEqual([rootId]);
      expect((await itemIds(documentId)).includes(leafId)).toBe(false);
    });

    it('keeps deleting bottom-up under the gate (parent waits for its leaf)', async () => {
      const { documentId, rootId } = await freshDocument();
      const parentId = randomUUID();
      await db.query(
        `INSERT INTO items (id, document_id, parent_id, rank, type, content, deleted_at)
         VALUES ($1, $2, $3, 'b', 'bullet', '', $4)`,
        [parentId, documentId, rootId, twoDaysAgo()],
      );
      const leafId = randomUUID();
      await db.query(
        `INSERT INTO items (id, document_id, parent_id, rank, type, content, deleted_at)
         VALUES ($1, $2, $3, 'b0', 'bullet', '', $4)`,
        [leafId, documentId, parentId, twoDaysAgo()],
      );

      // Bottom-up, ONE level per pass: the leaf goes first, the tombstoned
      // parent (a leaf once its child is gone) waits for the next pass.
      await runGc();
      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, parentId]));
      expect((await itemIds(documentId)).includes(leafId)).toBe(false);

      // Second pass clears the now-leaf parent; the third is a no-op (idempotent).
      await runGc();
      expect(await itemIds(documentId)).toEqual([rootId]);
      await runGc();
      expect(await itemIds(documentId)).toEqual([rootId]);
    });

    it('never deletes a tombstone with a live child, even when unblocked', async () => {
      const { documentId, rootId } = await freshDocument();
      const parentId = randomUUID();
      await db.query(
        `INSERT INTO items (id, document_id, parent_id, rank, type, content, deleted_at)
         VALUES ($1, $2, $3, 'c', 'bullet', '', $4)`,
        [parentId, documentId, rootId, twoDaysAgo()],
      );
      const liveChildId = randomUUID();
      await db.query(
        `INSERT INTO items (id, document_id, parent_id, rank, type, content)
         VALUES ($1, $2, $3, 'c0', 'bullet', '')`,
        [liveChildId, documentId, parentId],
      );

      await runGc();

      // The tombstoned parent has a LIVE child → not a leaf → retained bottom-up.
      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, parentId, liveChildId]));
    });
  });

  describe('stale-replica pruning (ADR-0019 TTL)', () => {
    it('prunes rows not seen since the cutoff, keeps fresh ones, returns the count', async () => {
      const { documentId } = await freshDocument();
      await touchReplica(db, { documentId, replicaId: 'old-synced', synced: true }, thirtyDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'old-never-synced', synced: false }, thirtyDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'fresh', synced: true }, oneDayAgo());

      const pruned = await pruneStaleReplicas(db, new Date(Date.now() - 7 * 86_400_000));
      expect(pruned).toBe(2);

      const remaining = await db.query<{ replica_id: string }>(
        `SELECT replica_id FROM replica_sync WHERE document_id = $1 ORDER BY replica_id`,
        [documentId],
      );
      expect(remaining.rows.map((r) => r.replica_id)).toEqual(['fresh']);
    });

    it('auto-heals a lost sync-ack: a never-synced replica stops blocking once its row ages past the TTL', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());
      // The lost-ack case (ADR-0019): the client connected but its stateless
      // ack was dropped with the socket, so the disconnect touch left
      // last_synced_at NULL forever and last_seen_at frozen at disconnect.
      await touchReplica(db, { documentId, replicaId: 'lost-ack', synced: false }, twoDaysAgo());

      // Within the default 14d TTL the row survives and blocks GC.
      const worker = createGcWorker(db, { retentionMs: 0, batchSize: 100 });
      await worker.run();
      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, leafId]));

      // Once the TTL elapses the row is pruned → the document unblocks. (A
      // returning replica would re-register a blocking row on connect and
      // re-gate until it syncs, so forgetting is safe.)
      const aggressive = createGcWorker(db, {
        retentionMs: 0,
        batchSize: 100,
        replicaStaleTtlMs: 0,
      });
      await aggressive.run();
      expect(await itemIds(documentId)).toEqual([rootId]);
    });

    it('keeps blocking while the replica was seen recently (heartbeat/connect freshness beats the TTL)', async () => {
      const { documentId, rootId } = await freshDocument();
      const leafId = await insertTombstone(documentId, rootId, twoDaysAgo());
      // Synced before the tombstone, but SEEN since (e.g. it reconnected and is
      // mid-sync, or its heartbeat just fired) — last_seen_at is fresh, so a
      // short TTL must not forget it while it may still hold pre-tombstone state.
      await touchReplica(db, { documentId, replicaId: 'recent', synced: true }, threeDaysAgo());
      await touchReplica(db, { documentId, replicaId: 'recent', synced: false }, sixHoursAgo());

      const worker = createGcWorker(db, {
        retentionMs: 0,
        batchSize: 100,
        replicaStaleTtlMs: 12 * 3_600_000, // 12h — shorter than the 6h-old touch
      });
      await worker.run();

      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, leafId]));
    });
  });
});
