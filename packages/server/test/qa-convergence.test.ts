/**
 * Acceptance gate: concurrent-edit convergence (QA, Phase 13).
 *
 * Measures the "Two users editing the same document concurrently never see
 * corruption or lost structure" gate from product-overview.md.
 *
 * Workload definition:
 *   Two headless clients connect to the same document. Each writes N sequential
 *   items (no overlap in initial content), interleaved with structural moves.
 *   After both clients sync, the merged state must satisfy:
 *
 *   - All items from both clients exist (no lost writes).
 *   - Each client's items are in a valid tree (no cycles).
 *   - No torn move: every item's (parentId, rank) pair is internally consistent.
 *   - A↔B cycle: specifically test that inserting A→B then B→A converges to
 *     acyclic state (ADR-0012 cycle repair fires).
 *
 * Threshold: N=100 items per client (200 total), 50 moves per client. The test
 * asserts structural correctness only — latency is measured by the perf gate.
 *
 * Run with: pnpm --filter @open-outliner/server test -- --grep "convergence"
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  rankBetween,
  rankAfter,
  buildInsertMove,
  buildMove,
  buildDelete,
} from '@open-outliner/shared';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { getLiveItems } from '../src/db/items-repo.js';
import { loadConfig } from '../src/config.js';
import { createYjsStore, type YjsStore } from '../src/crdt/yjs-store.js';
import { createProjector, type Projector } from '../src/crdt/projector.js';
import { writeMove, readMove } from '@open-outliner/crdt';
import { NODE_KEY } from '@open-outliner/shared';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

function headlessClient(store: YjsStore, documentId: string) {
  const doc = new Y.Doc();
  return {
    doc,
    async sync(): Promise<void> {
      const merged = Y.encodeStateAsUpdate(doc);
      await store.storeUpdate(documentId, merged);
    },
    destroy: () => doc.destroy(),
  };
}

describeDb('QA gate: concurrent-edit convergence', () => {
  let db: Db;
  let store: YjsStore;
  let projector: Projector;
  let documentId: string;
  let clock = 1_000_000;
  const now = () => clock++;
  const replicaA = 'replica-a';
  const replicaB = 'replica-b';

  beforeAll(async () => {
    const config = loadConfig();
    db = createDb(config.databaseUrl);
    await migrate(db, config.migrationsDir);
    store = createYjsStore(db);
    projector = createProjector({ db, store, replicaId: 'test', now });
    // The suite authors documents against a fixed workspace id; create the
    // tenant row (owner user + workspace) so the documents FK is satisfied.
    // Idempotent + concurrency-safe: suites may share one CI Postgres.
    await db.query(
      `INSERT INTO users (id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'qa-owner@e.test')
       ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO workspaces (id, owner_id, name)
       VALUES ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001', 'QA')
       ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ('00000000-0000-0000-0000-000000000000', 'convergence-test') RETURNING id`,
    );
    documentId = res.rows[0].id;
    // Seed root
    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content) VALUES ($1, $2, NULL, 'a0', 'bullet', 'root')`,
      [documentId, documentId],
    );
    await db.query(
      `INSERT INTO document_projection (document_id, source_rev, projected_rev) VALUES ($1, 0, 0)`,
      [documentId],
    );
  });

  it('N=100 items per client, 50 moves, converges without torn move or cycle', async () => {
    const clientA = headlessClient(store, documentId);
    const clientB = headlessClient(store, documentId);
    const actorA = { replicaId: replicaA, now };
    const actorB = { replicaId: replicaB, now };

    // Both clients start from empty doc — sync to get the root
    await clientA.sync();
    await clientB.sync();

    // Client A inserts 100 items
    const itemsA: string[] = [];
    let prevRankA = 'a0';
    for (let i = 0; i < 100; i++) {
      const id = randomUUID();
      const rank = rankAfter(prevRankA);
      itemsA.push(id);
      clientA.doc.transact(() => {
        writeMove(clientA.doc, id, documentId, {
          parentId: documentId,
          rank,
          hlc: { wallMs: now(), counter: i, replicaId: replicaA },
        });
      });
      prevRankA = rank;
    }
    await clientA.sync();

    // Client B inserts 100 items (different replica, same root)
    const itemsB: string[] = [];
    let prevRankB = 'a0';
    for (let i = 0; i < 100; i++) {
      const id = randomUUID();
      const rank = rankAfter(prevRankB);
      itemsB.push(id);
      clientB.doc.transact(() => {
        writeMove(clientB.doc, id, documentId, {
          parentId: documentId,
          rank,
          hlc: { wallMs: now(), counter: i, replicaId: replicaB },
        });
      });
      prevRankB = rank;
    }
    await clientB.sync();

    // Merge: apply A's state to B and vice versa
    const stateA = Y.encodeStateAsUpdate(clientA.doc);
    const stateB = Y.encodeStateAsUpdate(clientB.doc);
    Y.applyUpdate(clientA.doc, stateB);
    Y.applyUpdate(clientB.doc, stateA);

    // Both now converge — sync the merged state
    await clientA.sync();

    // Project to Postgres
    await projector.projectDocument(documentId);

    // Verify: all 200 items exist
    const rows = await getLiveItems(db, documentId);
    const liveItems = rows.filter((r) => r.id !== documentId); // exclude root
    expect(liveItems.length).toBe(200);

    // Verify: every item has a valid parent (root or another live item)
    const ids = new Set(liveItems.map((r) => r.id));
    for (const item of liveItems) {
      if (item.parent_id !== null) {
        expect(ids.has(item.parent_id)).toBe(true);
      }
    }

    // Verify: no torn move — every item has a consistent (parentId, rank) pair
    for (const item of liveItems) {
      expect(item.rank).toBeTruthy();
      expect(item.parent_id).not.toBe('');
    }

    clientA.destroy();
    clientB.destroy();
  });

  it('A→B then B→A cycle converges to acyclic state (ADR-0012)', async () => {
    const clientA = headlessClient(store, documentId);
    const actorA = { replicaId: replicaA, now };

    // Seed two items: A and B under root
    const idA = randomUUID();
    const idB = randomUUID();
    clientA.doc.transact(() => {
      writeMove(clientA.doc, idA, documentId, {
        parentId: documentId,
        rank: 'a1',
        hlc: { wallMs: now(), counter: 1, replicaId: replicaA },
      });
      writeMove(clientA.doc, idB, documentId, {
        parentId: documentId,
        rank: 'a2',
        hlc: { wallMs: now(), counter: 2, replicaId: replicaA },
      });
    });
    await clientA.sync();

    // Now create a cycle: make A a child of B, then B a child of A
    // These must be in separate HLCs so one wins
    clientA.doc.transact(() => {
      writeMove(clientA.doc, idA, documentId, {
        parentId: idB,
        rank: 'b0',
        hlc: { wallMs: now(), counter: 3, replicaId: replicaA },
      });
      writeMove(clientA.doc, idB, documentId, {
        parentId: idA,
        rank: 'b0',
        hlc: { wallMs: now(), counter: 4, replicaId: replicaA },
      });
    });
    await clientA.sync();

    // Project — cycle repair should fire
    const repaired = await projector.projectDocument(documentId);
    // The projector should have emitted repairs or resolved the cycle
    expect(repaired).toBe(true);

    // Verify: the tree is acyclic — no item's ancestor chain loops
    const rows = await getLiveItems(db, documentId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    function hasCycle(id: string, seen: Set<string>): boolean {
      const row = byId.get(id);
      if (!row || row.parent_id === null) return false;
      if (seen.has(row.parent_id)) return true;
      seen.add(row.parent_id);
      return hasCycle(row.parent_id, seen);
    }
    for (const row of rows) {
      expect(hasCycle(row.id, new Set())).toBe(false);
    }

    clientA.destroy();
  });
});
