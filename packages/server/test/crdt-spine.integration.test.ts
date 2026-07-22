import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  rankBetween,
  rankAfter,
  buildRootMove,
  buildInsertMove,
  buildMove,
  buildDelete,
  type Hlc,
} from '@open-outliner/shared';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { getLiveItems } from '../src/db/items-repo.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace } from '../src/db/tenancy-repo.js';
import { createYjsStore, type YjsStore } from '../src/crdt/yjs-store.js';
import { createProjector, type Projector } from '../src/crdt/projector.js';
import { writeMove, writeContent, writeField, readMove } from '../src/crdt/yjs-node.js';
import { NODE_KEY } from '@open-outliner/shared';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

/** A headless client: a Y.Doc whose updates are pushed to the store like Hocuspocus would. */
function headlessClient(store: YjsStore, documentId: string) {
  const doc = new Y.Doc();
  const pending: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => pending.push(update));
  return {
    doc,
    /** Flush accumulated local updates to the durable store (simulates ack-after-persist). */
    async sync(): Promise<void> {
      const merged = Y.encodeStateAsUpdate(doc);
      pending.length = 0;
      await store.storeUpdate(documentId, merged);
    },
    destroy: () => doc.destroy(),
  };
}

describeDb('CRDT persistence spine (COL + MAT)', () => {
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

  async function freshDocument(): Promise<{ documentId: string; rootId: string; rootRank: string }> {
    const ownerId = await createUser(db, `u-${randomUUID()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'WS');
    // Create the document row WITHOUT a seeded root item (the CRDT authors the root).
    const doc = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ($1, 'Doc') RETURNING id`,
      [workspaceId],
    );
    const documentId = doc.rows[0]!.id;
    const rootId = randomUUID();
    const rootRank = rankBetween(null, null);
    return { documentId, rootId, rootRank };
  }

  const ctx = () => ({ replicaId: 'clientA', nowMs: now() });

  it('a typed bullet survives Yjs → yjs_updates → materializer → items → readback', async () => {
    const { documentId, rootId, rootRank } = await freshDocument();
    const client = headlessClient(store, documentId);

    // Author a root + one child bullet with text.
    writeMove(client.doc, rootId, buildRootMove(rootRank, ctx()));
    const childId = randomUUID();
    writeMove(
      client.doc,
      childId,
      buildInsertMove(childId, rootId, null, null, undefined, ctx()),
    );
    writeContent(client.doc, childId, 'hello world');
    writeField(client.doc, childId, NODE_KEY.type, 'bullet');

    await client.sync();
    await projector.projectDocument(documentId);

    const items = await getLiveItems(db, documentId);
    const root = items.find((i) => i.id === rootId);
    const child = items.find((i) => i.id === childId);
    expect(root?.parent_id).toBeNull(); // synthetic root projects to NULL
    expect(child?.parent_id).toBe(rootId);
    expect(child?.content).toBe('hello world');
    expect(child?.type).toBe('bullet');
    client.destroy();
  });

  it('projects sibling order by (rank, id)', async () => {
    const { documentId, rootId, rootRank } = await freshDocument();
    const client = headlessClient(store, documentId);
    writeMove(client.doc, rootId, buildRootMove(rootRank, ctx()));

    // Three children a < b < c by rank.
    const ra = rankAfter(null, 'a');
    const rb = rankAfter(ra, 'b');
    const rc = rankAfter(rb, 'c');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const ranks = [ra, rb, rc];
    for (let i = 0; i < 3; i++) {
      writeMove(client.doc, ids[i]!, buildMove(rootId, ranks[i]!, undefined, ctx()));
      writeContent(client.doc, ids[i]!, `item ${i}`);
    }
    await client.sync();
    await projector.projectDocument(documentId);

    const items = (await getLiveItems(db, documentId))
      .filter((i) => i.parent_id === rootId)
      .sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : x.id < y.id ? -1 : 1));
    expect(items.map((i) => i.content)).toEqual(['item 0', 'item 1', 'item 2']);
    client.destroy();
  });

  it('a soft-deleted subtree root is filtered from live reads (lazy tombstone)', async () => {
    const { documentId, rootId, rootRank } = await freshDocument();
    const client = headlessClient(store, documentId);
    writeMove(client.doc, rootId, buildRootMove(rootRank, ctx()));
    const parentId = randomUUID();
    const childId = randomUUID();
    writeMove(client.doc, parentId, buildInsertMove(parentId, rootId, null, null, undefined, ctx()));
    writeMove(client.doc, childId, buildInsertMove(childId, parentId, null, null, undefined, ctx()));
    await client.sync();
    await projector.projectDocument(documentId);
    expect((await getLiveItems(db, documentId)).some((i) => i.id === childId)).toBe(true);

    // Tombstone the parent only; the child must disappear from live reads (lazy).
    writeField(client.doc, parentId, NODE_KEY.type, 'bullet'); // touch to bump
    const { writeDeleted } = await import('../src/crdt/yjs-node.js');
    writeDeleted(client.doc, parentId, buildDelete(undefined, ctx()));
    await client.sync();
    await projector.projectDocument(documentId);

    const live = await getLiveItems(db, documentId);
    expect(live.some((i) => i.id === parentId)).toBe(false);
    expect(live.some((i) => i.id === childId)).toBe(false); // filtered under deleted ancestor
    client.destroy();
  });

  it('two concurrent clients merge with no torn move and no cycle', async () => {
    const { documentId, rootId, rootRank } = await freshDocument();
    // Seed: root + item X + item Y, synced from client A.
    const a = headlessClient(store, documentId);
    writeMove(a.doc, rootId, buildRootMove(rootRank, ctx()));
    const X = randomUUID();
    const Yid = randomUUID();
    writeMove(a.doc, X, buildInsertMove(X, rootId, null, null, undefined, ctx()));
    writeMove(a.doc, Yid, buildInsertMove(Yid, rootId, null, null, undefined, ctx()));
    await a.sync();

    // Two offline replicas fork from the same state.
    const stateA = await store.loadDocument(documentId);
    const stateB = await store.loadDocument(documentId);

    // Replica A moves X under Y (older move); Replica B moves Y under X (younger).
    const hlcOld: Hlc = { wallMs: 5000, counter: 0, replicaId: 'A' };
    const hlcNew: Hlc = { wallMs: 9000, counter: 0, replicaId: 'B' };
    writeMove(stateA, X, { parentId: Yid, rank: rankAfter(null, 'x'), hlc: hlcOld });
    writeMove(stateB, Yid, { parentId: X, rank: rankAfter(null, 'y'), hlc: hlcNew });

    // Both replicas sync their updates to the durable store (merge server-side).
    await store.storeUpdate(documentId, Y.encodeStateAsUpdate(stateA));
    await store.storeUpdate(documentId, Y.encodeStateAsUpdate(stateB));

    // Project: the server detects the cycle, emits a repair, and re-projects.
    await projector.projectDocument(documentId);

    const merged = await store.loadDocument(documentId);
    const mX = readMove(merged.getMap('items').get(X) as Y.Map<unknown>);
    const mY = readMove(merged.getMap('items').get(Yid) as Y.Map<unknown>);
    // No cycle: X and Y cannot both parent each other. The youngest edge (Y→X)
    // was broken, so Y is freed to become a top-level child of the root item
    // (exactly one item may carry the null-sentinel parent — the root itself).
    expect(mY?.parentId).toBe(rootId);
    expect(mX?.parentId).toBe(Yid); // X's older move stands

    // The projection is acyclic and both items are reachable from root.
    const live = await getLiveItems(db, documentId);
    const rowY = live.find((i) => i.id === Yid);
    expect(rowY?.parent_id).toBe(rootId);
    a.destroy();
    stateA.destroy();
    stateB.destroy();
    merged.destroy();
  });

  it('monotonic guard: a stale (older source_rev) pass no-ops instead of regressing', async () => {
    const { documentId, rootId, rootRank } = await freshDocument();
    const client = headlessClient(store, documentId);
    writeMove(client.doc, rootId, buildRootMove(rootRank, ctx()));
    const c1 = randomUUID();
    writeMove(client.doc, c1, buildInsertMove(c1, rootId, null, null, undefined, ctx()));
    writeContent(client.doc, c1, 'first');
    await client.sync();
    await projector.projectDocument(documentId);

    // Manually set projected_rev ahead of source_rev to simulate a newer pass
    // having already committed; a re-run must no-op (S <= P).
    await db.query(
      `UPDATE document_projection SET projected_rev = source_rev WHERE document_id = $1`,
      [documentId],
    );
    const ran = await projector.projectDocument(documentId);
    expect(ran).toBe(false);
    client.destroy();
  });

  it('catch-up sweep re-projects a document whose projection was lost', async () => {
    const { documentId, rootId, rootRank } = await freshDocument();
    const client = headlessClient(store, documentId);
    writeMove(client.doc, rootId, buildRootMove(rootRank, ctx()));
    const c1 = randomUUID();
    writeMove(client.doc, c1, buildInsertMove(c1, rootId, null, null, undefined, ctx()));
    writeContent(client.doc, c1, 'recovered');
    await client.sync();

    // Simulate a crash in the persist→debounce gap: source_rev advanced (from
    // sync) but projection never ran, so projected_rev < source_rev.
    const before = await getLiveItems(db, documentId);
    expect(before.some((i) => i.id === c1)).toBe(false); // not yet projected

    const swept = await projector.sweep();
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await getLiveItems(db, documentId);
    expect(after.find((i) => i.id === c1)?.content).toBe('recovered');
    client.destroy();
  });

  beforeEach(() => {
    // keep clock advancing across tests
  });
});
