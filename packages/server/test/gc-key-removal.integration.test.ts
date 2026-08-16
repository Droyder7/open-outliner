import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { Connection } from '@hocuspocus/server';
import {
  rankBetween,
  buildRootMove,
  buildInsertMove,
  buildDelete,
  buildUndelete,
} from '@open-outliner/shared';
import { writeMove, writeContent, writeDeleted, readDeleted, itemsMap } from '@open-outliner/crdt';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace } from '../src/db/tenancy-repo.js';
import { createYjsStore, type YjsStore } from '../src/crdt/yjs-store.js';
import { createProjector, type Projector } from '../src/crdt/projector.js';
import { createConnectionRegistry } from '../src/crdt/connections.js';
import { removeTombstoneKeysFromStore } from '../src/crdt/gc-keys.js';
import { createGcWorker } from '../src/jobs/gc.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

/** A headless client: a Y.Doc whose updates are pushed to the store like Hocuspocus would. */
function headlessClient(store: YjsStore, documentId: string) {
  const doc = new Y.Doc();
  return {
    doc,
    async sync(): Promise<void> {
      await store.storeUpdate(documentId, Y.encodeStateAsUpdate(doc));
    },
    destroy: () => doc.destroy(),
  };
}

describeDb('GC key removal — hard-delete sticks (ADR-0006/0019)', () => {
  let db: Db;
  let store: YjsStore;
  let projector: Projector;
  const config = loadConfig();
  let clock = 1_000_000;
  const now = () => clock++;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);
    store = createYjsStore(db);
    projector = createProjector({ db, store, replicaId: 'server', now });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function freshDocument(): Promise<{ documentId: string; rootId: string }> {
    const ownerId = await createUser(db, `u-${randomUUID()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'WS');
    const doc = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ($1, 'Doc') RETURNING id`,
      [workspaceId],
    );
    const documentId = doc.rows[0]!.id;
    const rootId = randomUUID();
    const client = headlessClient(store, documentId);
    writeMove(client.doc, rootId, buildRootMove(rankBetween(null, null), ctx()));
    await client.sync();
    await projector.projectDocument(documentId);
    client.destroy();
    return { documentId, rootId };
  }

  const ctx = () => ({ replicaId: 'clientA', nowMs: now() });

  /** Author a child bullet under root, project, then tombstone it and re-project. */
  async function tombstonedLeaf(
    documentId: string,
    rootId: string,
  ): Promise<{ childId: string; client: ReturnType<typeof headlessClient> }> {
    const childId = randomUUID();
    const client = headlessClient(store, documentId);
    writeMove(client.doc, childId, buildInsertMove(childId, rootId, null, null, undefined, ctx()));
    writeContent(client.doc, childId, 'delete me');
    await client.sync();
    await projector.projectDocument(documentId);

    writeDeleted(client.doc, childId, buildDelete(undefined, ctx()));
    await client.sync();
    await projector.projectDocument(documentId);
    return { childId, client };
  }

  async function itemIds(documentId: string): Promise<string[]> {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM items WHERE document_id = $1 ORDER BY id`,
      [documentId],
    );
    return res.rows.map((r) => r.id);
  }

  function gcWorker(overrides: {
    removeTombstoneKeys?: (documentId: string, itemIds: readonly string[]) => Promise<void>;
    liveConnections?: () => import('../src/crdt/connections.js').RegisteredConnection[];
  } = {}) {
    return createGcWorker(db, {
      retentionMs: 0,
      batchSize: 100,
      removeTombstoneKeys:
        overrides.removeTombstoneKeys ??
        ((documentId, ids) => removeTombstoneKeysFromStore(store, documentId, ids)),
      ...(overrides.liveConnections ? { liveConnections: overrides.liveConnections } : {}),
    });
  }

  it('hard-deletes the row AND the Yjs key; the row stays gone across re-projection and later edits', async () => {
    const { documentId, rootId } = await freshDocument();
    const { childId, client } = await tombstonedLeaf(documentId, rootId);

    // Sanity: the tombstone was projected.
    expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, childId]));

    await gcWorker().run();

    // Row gone…
    expect(await itemIds(documentId)).toEqual([rootId]);
    // …and the CRDT key gone from the durable store.
    const reloaded = await store.loadDocument(documentId);
    try {
      expect(itemsMap(reloaded).has(childId)).toBe(false);
    } finally {
      reloaded.destroy();
    }

    // Re-projection (the key removal advanced source_rev) must NOT re-upsert.
    await projector.projectDocument(documentId);
    expect(await itemIds(documentId)).toEqual([rootId]);

    // A later edit to the same document must not resurrect the tombstone either.
    const survivor = randomUUID();
    writeMove(client.doc, survivor, buildInsertMove(survivor, rootId, null, null, undefined, ctx()));
    writeContent(client.doc, survivor, 'still alive');
    await client.sync();
    await projector.projectDocument(documentId);

    const remaining = await itemIds(documentId);
    expect(remaining).toEqual(expect.arrayContaining([rootId, survivor]));
    expect(remaining).not.toContain(childId);
    client.destroy();
  });

  it('an unsynced live connection blocks GC for its document even with a clear ledger; sync-ack unblocks', async () => {
    const { documentId, rootId } = await freshDocument();
    const { childId, client } = await tombstonedLeaf(documentId, rootId);

    const registry = createConnectionRegistry();
    registry.register('socket-1', 'session-1', documentId, 'replica-a', { close: () => {} } as unknown as Connection);

    // Ledger is empty (no known replicas → unblocked), but the live socket is
    // still mid-initial-sync: the whole document must be skipped.
    await gcWorker({ liveConnections: () => registry.liveConnections() }).run();
    expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, childId]));

    // The client acks its completed sync → GC may proceed.
    registry.markSynced('socket-1');
    await gcWorker({ liveConnections: () => registry.liveConnections() }).run();
    expect(await itemIds(documentId)).toEqual([rootId]);
    client.destroy();
  });

  it('a stale live child whose parent key was removed does not brick the projection (skip, no FK error)', async () => {
    const { documentId, rootId } = await freshDocument();
    const { childId } = await tombstonedLeaf(documentId, rootId);
    await gcWorker().run();
    expect(await itemIds(documentId)).toEqual([rootId]);

    // A replica that was offline during GC reconnects holding a LIVE child
    // under the removed key (it never saw the tombstone). Its update
    // re-creates the child in the merged CRDT with a dangling parentId.
    const stale = headlessClient(store, documentId);
    const orphan = randomUUID();
    writeMove(stale.doc, orphan, buildInsertMove(orphan, childId, null, null, undefined, ctx()));
    writeContent(stale.doc, orphan, 'orphan');
    await stale.sync();

    // The pass must not throw (no same-document FK violation) and must still
    // project the rest of the document; the orphan stays unprojected until its
    // parent reappears (e.g. a later undo re-creates the key).
    await expect(projector.projectDocument(documentId)).resolves.toBe(true);
    expect(await itemIds(documentId)).toEqual([rootId]);
    stale.destroy();
  });

  it('a fully-synced live connection does not block GC (heartbeat/ack covers it)', async () => {
    const { documentId, rootId } = await freshDocument();
    const { childId, client } = await tombstonedLeaf(documentId, rootId);

    const registry = createConnectionRegistry();
    registry.register('socket-1', 'session-1', documentId, 'replica-a', { close: () => {} } as unknown as Connection);
    registry.markSynced('socket-1');

    await gcWorker({ liveConnections: () => registry.liveConnections() }).run();
    expect(await itemIds(documentId)).toEqual([rootId]);
    expect((await itemIds(documentId)).includes(childId)).toBe(false);
    client.destroy();
  });

  describe('undo-after-hard-delete (ADR-0006/0011 edge)', () => {
    /** Read the projected tombstone row for an item (null deleted_at = live). */
    async function projectedRow(documentId: string, itemId: string): Promise<{
      deleted_at: Date | null;
      content: string;
    }> {
      const res = await db.query<{ deleted_at: Date | null; content: string }>(
        `SELECT deleted_at, content FROM items WHERE id = $1 AND document_id = $2`,
        [itemId, documentId],
      );
      return res.rows[0]!;
    }

    it('a stale replica with pre-tombstone state re-creates the key; the item re-projects as live', async () => {
      const { documentId, rootId } = await freshDocument();
      const { childId } = await tombstonedLeaf(documentId, rootId);
      await gcWorker().run();
      expect(await itemIds(documentId)).toEqual([rootId]);

      // Replica B was offline before the tombstone and still holds the child
      // LIVE. On reconnect its update merges into the store and re-creates the
      // key that GC removed (ADR-0019 accepted edge).
      const stale = headlessClient(store, documentId);
      // The merge of the stale replica's re-sent `set` against the GC's map
      // `delete` is LWW by Yjs (clientId, clock). Pin the replica's client id
      // above the uint32 space of randomly-minted ids so its write is always
      // the later op and the re-created key is deterministic (the GC author's
      // id is random.uint32, strictly < 2^32). Without this the test outcome
      // depended on which random client id won.
      stale.doc.clientID = 2 ** 32;
      writeMove(
        stale.doc,
        childId,
        buildInsertMove(childId, rootId, null, null, undefined, {
          replicaId: 'staleB',
          nowMs: now(),
        }),
      );
      writeContent(stale.doc, childId, 'still here');
      await stale.sync();

      await expect(projector.projectDocument(documentId)).resolves.toBe(true);
      const remaining = await itemIds(documentId);
      expect(remaining).toEqual(expect.arrayContaining([rootId, childId]));
      const row = await projectedRow(documentId, childId);
      expect(row.deleted_at).toBeNull(); // live, not a tombstone
      expect(row.content).toBe('still here');

      // GC must not touch the resurrected live item.
      await gcWorker().run();
      expect(await itemIds(documentId)).toEqual(expect.arrayContaining([rootId, childId]));
      stale.destroy();
    });

    it('a stale undo (same replica, same Yjs id) after hard-delete cannot resurrect the key — the delete is durable', async () => {
      const { documentId, rootId } = await freshDocument();
      const { childId, client } = await tombstonedLeaf(documentId, rootId);
      await gcWorker().run();
      expect(await itemIds(documentId)).toEqual([rootId]);
      const afterGc = await store.loadDocument(documentId);
      try {
        expect(itemsMap(afterGc).has(childId)).toBe(false);
      } finally {
        afterGc.destroy();
      }

      // A replica that HAD synced the tombstone issues an undo (ADR-0011:
      // isDeleted:false with a strictly-greater HLC) AFTER the server hard-
      // deleted the key. Its re-sent full state re-creates the SAME Yjs item id
      // that the GC delete already consumed, so the merge is a no-op: the
      // durable key removal wins and the item does NOT resurrect. (Undo before
      // GC works normally — the gate exists precisely so GC only removes keys
      // once every replica acked the tombstone; this pins the race outcome.)
      const del = readDeleted(itemsMap(client.doc).get(childId)!);
      expect(del.isDeleted).toBe(true);
      writeDeleted(client.doc, childId, buildUndelete(del.hlc, ctx()));
      await client.sync();

      await expect(projector.projectDocument(documentId)).resolves.toBe(true);
      expect(await itemIds(documentId)).toEqual([rootId]);

      // The loop stays healthy: a later GC pass is a no-op and the key stays gone.
      await gcWorker().run();
      expect(await itemIds(documentId)).toEqual([rootId]);
      const reloaded = await store.loadDocument(documentId);
      try {
        expect(itemsMap(reloaded).has(childId)).toBe(false);
      } finally {
        reloaded.destroy();
      }
      client.destroy();
    });
  });
});
