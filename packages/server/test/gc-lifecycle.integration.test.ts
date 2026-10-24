import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { Connection } from '@hocuspocus/server';
import { buildRootMove, buildInsertMove, buildDelete } from '@open-outliner/shared';
import { writeMove, writeDeleted, itemsMap } from '@open-outliner/crdt';
import { createDb, withDocumentLock, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace } from '../src/db/tenancy-repo.js';
import { touchReplica } from '../src/db/replica-sync-repo.js';
import { createYjsStore } from '../src/crdt/yjs-store.js';
import { createProjector } from '../src/crdt/projector.js';
import { createCollabServer, type CollabServer } from '../src/crdt/server.js';
import { prepareTombstoneKeysFromStore } from '../src/crdt/gc-keys.js';
import { createGcWorker, type GcConfig } from '../src/jobs/gc.js';
import { createCompactionWorker } from '../src/jobs/compaction.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeDb('GC prepared document lifecycle (ADR-0020)', () => {
  let db: Db;
  const documents: { documentId: string; workspaceId: string; ownerId: string }[] = [];
  const servers: CollabServer[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await migrate(db, loadConfig().migrationsDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      server.stopAuthHeartbeat();
      await server.hocuspocus.destroy();
    }
    for (const { documentId, workspaceId, ownerId } of documents.splice(0)) {
      // A release-triggered projection may still be completing. Use the same
      // lock ordering as production while removing the fixture's SQL rows.
      await withDocumentLock(db, documentId, async (tx) => {
        await tx.query('DELETE FROM items WHERE document_id = $1', [documentId]);
        await tx.query('DELETE FROM documents WHERE id = $1', [documentId]);
        await tx.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        await tx.query('DELETE FROM users WHERE id = $1', [ownerId]);
      });
    }
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fixture() {
    const ownerId = await createUser(db, `${randomUUID()}@gc.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'GC lifecycle');
    const result = await db.query<{ id: string }>(
      "INSERT INTO documents (workspace_id, title) VALUES ($1, 'Doc') RETURNING id",
      [workspaceId],
    );
    const documentId = result.rows[0]!.id;
    documents.push({ documentId, workspaceId, ownerId });
    const rootId = randomUUID();
    const childId = randomUUID();
    const store = createYjsStore(db);
    const doc = new Y.Doc();
    const ctx = { replicaId: 'fixture', nowMs: 1000 };
    writeMove(doc, rootId, buildRootMove('a0', ctx));
    writeMove(doc, childId, buildInsertMove(childId, rootId, null, null, undefined, ctx));
    writeDeleted(doc, childId, buildDelete(undefined, ctx));
    await store.storeUpdate(documentId, Y.encodeStateAsUpdate(doc));
    doc.destroy();
    await createProjector({ db, store, replicaId: 'server' }).projectDocument(documentId);
    await db.query("UPDATE items SET deleted_at = now() - interval '2 days' WHERE id = $1", [
      childId,
    ]);
    const hasRow = async () =>
      (await db.query('SELECT id FROM items WHERE id = $1', [childId])).rows.length > 0;
    return { documentId, childId, rootId, store, hasRow };
  }

  function collab() {
    const server = createCollabServer({ db, replicaId: 'server', sessionCookieName: 'oo_session' });
    servers.push(server);
    return server;
  }

  function worker(config: GcConfig = {}, database = db) {
    return createGcWorker(database, {
      retentionMs: 0,
      prepareTombstoneKeyRemoval: (id) => prepareTombstoneKeysFromStore(createYjsStore(db), id),
      ...config,
    });
  }

  async function lockIsFree(documentId: string) {
    return db.transaction(async (tx) => {
      const res = await tx.query<{ free: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS free',
        [documentId],
      );
      return res.rows[0]!.free;
    });
  }

  it('keeps the advisory lock free during cold replay and release, and persists before release', async () => {
    const f = await fixture();
    const server = collab();
    const loading = deferred();
    const resume = deferred();
    const loadDocument = vi.spyOn(server.store, 'loadDocument');
    const load = server.store.loadDocumentState.bind(server.store);
    const replay = vi.spyOn(server.store, 'loadDocumentState').mockImplementation(async (id) => {
      if (id === f.documentId) {
        loading.resolve();
        await resume.promise;
      }
      return load(id);
    });
    let released = false;
    const gc = worker({
      prepareTombstoneKeyRemoval: async (id) => {
        const prepared = await server.prepareTombstoneKeyRemoval(id);
        return {
          remove: async (ids) => {
            if (id === f.documentId) expect(await lockIsFree(id)).toBe(false);
            await prepared.remove(ids);
          },
          release: async () => {
            if (id === f.documentId) {
              expect(await lockIsFree(id)).toBe(true);
              expect(await f.hasRow()).toBe(false);
              const reloaded = await f.store.loadDocument(id);
              try {
                expect(itemsMap(reloaded).has(f.childId)).toBe(false);
              } finally {
                reloaded.destroy();
              }
              released = true;
            }
            await prepared.release();
          },
        };
      },
    });
    const pass = gc.run();
    try {
      await loading.promise;
      expect(await lockIsFree(f.documentId)).toBe(true);
    } finally {
      resume.resolve();
      await pass;
    }
    expect(released).toBe(true);
    expect(replay.mock.calls.filter(([id]) => id === f.documentId)).toHaveLength(1);
    expect(loadDocument.mock.calls.filter(([id]) => id === f.documentId)).toHaveLength(1);
    await server.projector.projectDocument(f.documentId);
    expect(await f.hasRow()).toBe(false);
    expect(server.hocuspocus.documents.get(f.documentId)?.directConnectionsCount ?? 0).toBe(0);
  });

  it('pins a live room when its last other connection disconnects, then releases idempotently', async () => {
    const f = await fixture();
    const server = collab();
    const client = await server.hocuspocus.openDirectConnection(f.documentId);
    const room = client.document!;
    const prepared = await server.prepareTombstoneKeyRemoval(f.documentId);
    await client.disconnect();
    expect(room.isDestroyed).toBe(false);
    expect(room.directConnectionsCount).toBe(1);
    await prepared.remove([f.childId]);
    const durable = await f.store.loadDocument(f.documentId);
    try {
      expect(itemsMap(durable).has(f.childId)).toBe(false);
    } finally {
      durable.destroy();
    }
    await prepared.release();
    await prepared.release();
    expect(room.directConnectionsCount).toBe(0);
    await expect(prepared.remove([f.childId])).rejects.toThrow('released');
  });

  it.each(['joining', 'becoming unsynced'])(
    'rechecks a client %s during preparation',
    async (mode) => {
      const f = await fixture();
      const server = collab();
      const register = () =>
        server.connections.register('socket', 'session', f.documentId, undefined, {} as Connection);
      if (mode === 'becoming unsynced') {
        register();
        server.connections.markSynced('socket');
      }
      await worker({
        liveConnections: () => server.connections.liveConnections(),
        prepareTombstoneKeyRemoval: async (id) => {
          const handle = await server.prepareTombstoneKeyRemoval(id);
          if (id === f.documentId) register();
          return handle;
        },
      }).run();
      expect(await f.hasRow()).toBe(true);
      expect(server.hocuspocus.documents.get(f.documentId)?.directConnectionsCount ?? 0).toBe(0);
    },
  );

  it.each(['retention', 'leaf', 'replica'])(
    'rechecks %s eligibility under the lock',
    async (change) => {
      const f = await fixture();
      const prepare = vi.fn(async (id: string) => {
        const prepared = await prepareTombstoneKeysFromStore(f.store, id);
        if (id === f.documentId) {
          if (change === 'retention')
            await db.query('UPDATE items SET deleted_at = NULL WHERE id = $1', [f.childId]);
          if (change === 'leaf')
            await db.query(
              "INSERT INTO items (id, document_id, parent_id, rank, type, content) VALUES ($1,$2,$3,'a0','bullet','')",
              [randomUUID(), id, f.childId],
            );
          if (change === 'replica')
            await touchReplica(
              db,
              { documentId: id, replicaId: 'late', synced: false },
              new Date(),
            );
        }
        return prepared;
      });
      await worker({ prepareTombstoneKeyRemoval: prepare }).run();
      expect(prepare).toHaveBeenCalled();
      expect(await f.hasRow()).toBe(true);
    },
  );

  it('skips preparation entirely when the replica gate is blocked', async () => {
    const f = await fixture();
    await touchReplica(
      db,
      { documentId: f.documentId, replicaId: 'offline', synced: false },
      new Date(),
    );
    const prepare = vi.fn(async (id: string) => prepareTombstoneKeysFromStore(f.store, id));
    await worker({ prepareTombstoneKeyRemoval: prepare }).run();
    expect(prepare.mock.calls.some(([id]) => id === f.documentId)).toBe(false);
    expect(await f.hasRow()).toBe(true);
  });

  it('does not leak a room when Hocuspocus preparation fails', async () => {
    const f = await fixture();
    const server = collab();
    const load = server.store.loadDocumentState.bind(server.store);
    vi.spyOn(server.store, 'loadDocumentState').mockImplementation(async (id) => {
      if (id === f.documentId) throw new Error('replay failed');
      return load(id);
    });
    const log = vi.fn();
    await worker({
      log,
      prepareTombstoneKeyRemoval: (id) => server.prepareTombstoneKeyRemoval(id),
    }).run();
    expect(await f.hasRow()).toBe(true);
    expect(server.hocuspocus.documents.has(f.documentId)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('replay failed'));
  });

  it('allows compaction during preparation and keeps the retained document valid', async () => {
    const f = await fixture();
    const server = collab();
    const compactor = createCompactionWorker(db, { updateThreshold: 0 });
    await worker({
      prepareTombstoneKeyRemoval: async (id) => {
        const prepared = await server.prepareTombstoneKeyRemoval(id);
        try {
          if (id === f.documentId) expect(await compactor.compactDocument(id)).toBe(true);
          return prepared;
        } catch (err) {
          await prepared.release();
          throw err;
        }
      },
    }).run();
    expect(await f.hasRow()).toBe(false);
    const durable = await f.store.loadDocument(f.documentId);
    try {
      expect(itemsMap(durable).has(f.childId)).toBe(false);
    } finally {
      durable.destroy();
    }
  });

  it('skips overlapping runs and resets the guard after preparation failure', async () => {
    const f = await fixture();
    const entered = deferred();
    const resume = deferred();
    let fail = true;
    const log = vi.fn();
    const gc = worker({
      log,
      prepareTombstoneKeyRemoval: async (id) => {
        if (id === f.documentId && fail) {
          entered.resolve();
          await resume.promise;
          throw new Error('load failed');
        }
        return prepareTombstoneKeysFromStore(f.store, id);
      },
    });
    const first = gc.run();
    try {
      await entered.promise;
      expect(await gc.run()).toBe(0);
    } finally {
      resume.resolve();
      await first;
    }
    expect(await f.hasRow()).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('load failed'));
    fail = false;
    await gc.run();
    expect(await f.hasRow()).toBe(false);
  });

  it('rolls back relational deletion and releases the handle when a transaction fails', async () => {
    const f = await fixture();
    const release = vi.fn(async () => {
      expect(await lockIsFree(f.documentId)).toBe(true);
    });
    const failingDb: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction(async (tx) => {
          const result = await fn(tx);
          throw new Error(`transaction failed after result ${result}`);
        }),
    };
    const log = vi.fn();
    await worker(
      {
        log,
        prepareTombstoneKeyRemoval: async (id) => {
          const prepared = await prepareTombstoneKeysFromStore(f.store, id);
          return {
            remove: prepared.remove,
            release: async () => {
              await prepared.release();
              if (id === f.documentId) await release();
            },
          };
        },
      },
      failingDb,
    ).run();
    expect(await f.hasRow()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('transaction failed'));
  });

  it('preserves both failure logs and relational rows when persistence and cleanup fail', async () => {
    const f = await fixture();
    const server = collab();
    const persist = server.store.storeUpdate.bind(server.store);
    let failed = false;
    vi.spyOn(server.store, 'storeUpdate').mockImplementation(async (id, update) => {
      if (id === f.documentId && !failed) {
        failed = true;
        throw new Error('persist failed');
      }
      return persist(id, update);
    });
    const log = vi.fn();
    const release = vi.fn();
    await worker({
      log,
      prepareTombstoneKeyRemoval: async (id) => {
        const prepared = await server.prepareTombstoneKeyRemoval(id);
        return {
          remove: prepared.remove,
          release: async () => {
            await prepared.release();
            if (id === f.documentId) {
              release();
              throw new Error('release failed');
            }
          },
        };
      },
    }).run();
    expect(await f.hasRow()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('persist failed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('release failed'));
    expect(server.hocuspocus.documents.get(f.documentId)?.directConnectionsCount ?? 0).toBe(0);
  });

  it('keeps a committed deletion successful when release fails', async () => {
    const f = await fixture();
    const log = vi.fn();
    const removed = await worker({
      log,
      prepareTombstoneKeyRemoval: async (id) => {
        const prepared = await prepareTombstoneKeysFromStore(f.store, id);
        return {
          remove: prepared.remove,
          release: async () => {
            await prepared.release();
            if (id === f.documentId) throw new Error('cleanup failed');
          },
        };
      },
    }).run();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await f.hasRow()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
  });

  it('serializes preparation and release across documents', async () => {
    await fixture();
    await fixture();
    let active = 0;
    let max = 0;
    await worker({
      prepareTombstoneKeyRemoval: async (id) => {
        active++;
        max = Math.max(max, active);
        const prepared = await prepareTombstoneKeysFromStore(createYjsStore(db), id);
        return {
          remove: prepared.remove,
          release: async () => {
            await prepared.release();
            active--;
          },
        };
      },
    }).run();
    expect(max).toBe(1);
    expect(active).toBe(0);
  });
});
