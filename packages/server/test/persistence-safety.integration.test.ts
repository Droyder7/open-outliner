import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { writeMove, writeContent, itemsMap } from '@open-outliner/crdt';
import { ROOT_PARENT_SENTINEL } from '@open-outliner/shared';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace } from '../src/db/tenancy-repo.js';
import { createYjsStore } from '../src/crdt/yjs-store.js';
import { createProjector } from '../src/crdt/projector.js';
import { createCompactionWorker } from '../src/jobs/compaction.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('personal-first persistence safety', () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await migrate(db, loadConfig().migrationsDir);
  });
  afterAll(async () => {
    await db?.close();
  });
  async function fixture() {
    const u = await createUser(db, `${randomUUID()}@safety.test`, null, 'h');
    const ws = await createWorkspace(db, u, 'Safety');
    const result = await db.query<{ id: string }>(
      "INSERT INTO documents(workspace_id,title) VALUES($1,'Doc') RETURNING id",
      [ws],
    );
    const id = result.rows[0]!.id;
    const doc = new Y.Doc();
    writeMove(doc, id, {
      parentId: ROOT_PARENT_SENTINEL,
      rank: 'a0',
      hlc: { wallMs: 1, counter: 0, replicaId: 'x' },
    });
    const store = createYjsStore(db);
    await store.storeUpdate(id, Y.encodeStateAsUpdate(doc));
    return { id, doc, store };
  }
  function add(doc: Y.Doc, root: string) {
    const id = randomUUID();
    writeMove(doc, id, {
      parentId: root,
      rank: 'a0',
      hlc: { wallMs: 2, counter: 0, replicaId: 'x' },
    });
    return id;
  }
  it('does not label an old snapshot with a newer revision; the next pass catches up', async () => {
    const f = await fixture();
    let child = '';
    let injected = false;
    const store = {
      ...f.store,
      loadDocumentSnapshot: async (id: string) => {
        const snapshot = await f.store.loadDocumentSnapshot(id);
        if (id === f.id && !injected) {
          injected = true;
          child = add(f.doc, id);
          await f.store.storeUpdate(id, Y.encodeStateAsUpdate(f.doc));
        }
        return snapshot;
      },
    };
    const projector = createProjector({ db, store, replicaId: 'server' });
    await projector.projectDocument(f.id);
    const rev = await db.query(
      'SELECT source_rev, projected_rev FROM document_projection WHERE document_id=$1',
      [f.id],
    );
    expect(Number(rev.rows[0]!.source_rev)).toBeGreaterThan(Number(rev.rows[0]!.projected_rev));
    await projector.projectDocument(f.id);
    expect((await db.query('SELECT id FROM items WHERE id=$1', [child])).rows).toHaveLength(1);
    f.doc.destroy();
  });
  it('keeps appends committed between compaction read and truncation', async () => {
    const f = await fixture();
    let child = '';
    let injected = false;
    const raced: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: async (sql, params) => {
              if (sql.startsWith('DELETE FROM yjs_updates') && !injected) {
                injected = true;
                child = add(f.doc, f.id);
                await f.store.storeUpdate(f.id, Y.encodeStateAsUpdate(f.doc));
              }
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await createCompactionWorker(raced, { updateThreshold: 0 }).compactDocument(f.id);
    const loaded = await f.store.loadDocument(f.id);
    expect(itemsMap(loaded).has(child)).toBe(true);
    loaded.destroy();
    f.doc.destroy();
  });
  it('retains a delayed commit whose allocated row ID predates the visible snapshot', async () => {
    const f = await fixture();
    const child = add(f.doc, f.id);
    const delayed = await db.pool.connect();
    let committed = false;
    try {
      await delayed.query('BEGIN');
      await delayed.query('INSERT INTO yjs_updates(document_id,update) VALUES($1,$2)', [
        f.id,
        Buffer.from(Y.encodeStateAsUpdate(f.doc)),
      ]);
      const other = new Y.Doc();
      const loaded = await f.store.loadDocument(f.id);
      Y.applyUpdate(other, Y.encodeStateAsUpdate(loaded));
      loaded.destroy();
      writeContent(other, f.id, 'visible later allocation');
      await f.store.storeUpdate(f.id, Y.encodeStateAsUpdate(other));
      other.destroy();
      const raced: Db = {
        ...db,
        transaction: (fn) =>
          db.transaction((tx) =>
            fn({
              query: async (sql, params) => {
                if (sql.startsWith('DELETE FROM yjs_updates') && !committed) {
                  await delayed.query(
                    'UPDATE document_projection SET source_rev=source_rev+1 WHERE document_id=$1',
                    [f.id],
                  );
                  await delayed.query('COMMIT');
                  committed = true;
                }
                return tx.query(sql, params);
              },
            }),
          ),
      };
      await createCompactionWorker(raced, { updateThreshold: 0 }).compactDocument(f.id);
      const reloaded = await f.store.loadDocument(f.id);
      expect(itemsMap(reloaded).has(child)).toBe(true);
      reloaded.destroy();
    } finally {
      if (!committed) await delayed.query('ROLLBACK');
      delayed.release();
      f.doc.destroy();
    }
  });
  it('fails closed on corruption instead of replacing the only durable input', async () => {
    const f = await fixture();
    await db.query('INSERT INTO yjs_updates(document_id,update) VALUES($1,$2)', [
      f.id,
      Buffer.from([255]),
    ]);
    const count = await db.query('SELECT count(*) AS n FROM yjs_updates WHERE document_id=$1', [
      f.id,
    ]);
    await expect(
      createCompactionWorker(db, { updateThreshold: 0 }).compactDocument(f.id),
    ).rejects.toThrow();
    expect(
      (await db.query('SELECT count(*) AS n FROM yjs_updates WHERE document_id=$1', [f.id]))
        .rows[0]!.n,
    ).toBe(count.rows[0]!.n);
    await expect(f.store.loadDocumentSnapshot(f.id)).rejects.toThrow();
    f.doc.destroy();
  });
  it('rejects a foreign item identity without modifying its owner document', async () => {
    const a = await fixture(),
      b = await fixture();
    const projector = createProjector({ db, store: a.store, replicaId: 'server' });
    await projector.projectDocument(a.id);
    await projector.projectDocument(b.id);
    writeMove(b.doc, a.id, {
      parentId: ROOT_PARENT_SENTINEL,
      rank: 'a0',
      hlc: { wallMs: 3, counter: 0, replicaId: 'x' },
    });
    writeContent(b.doc, a.id, 'foreign');
    await b.store.storeUpdate(b.id, Y.encodeStateAsUpdate(b.doc));
    await expect(projector.projectDocument(b.id)).rejects.toThrow('another document');
    const rows = await db.query('SELECT content,document_id FROM items WHERE id=$1', [a.id]);
    expect(rows.rows[0]!.content).toBe('');
    expect(rows.rows[0]!.document_id).toBe(a.id);
    a.doc.destroy();
    b.doc.destroy();
  });
});
