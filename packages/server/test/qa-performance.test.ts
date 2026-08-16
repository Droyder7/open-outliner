/**
 * Acceptance gate: 10k-item move/reorder responsiveness (QA, Phase 13).
 *
 * Measures the "Reordering/moving 10k-item outlines stays responsive" gate.
 *
 * Workload: 10,000 items under a single parent, in fractional-index order.
 * Operation: move the last item to the first position (worst case for rank
 * recalculation — must generate a rank between the sentinel and the current
 * first item's rank).
 *
 * Threshold: the move + projection must complete in < 500ms (P95) on the CI
 * runner. This is a regression gate — if the number drops, the ranking or
 * projection path has a performance regression.
 *
 * Run with: pnpm --filter @open-outliner/server test -- --grep "10k"
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { rankBetween, rankAfter, ROOT_PARENT_SENTINEL } from '@open-outliner/shared';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { getLiveItems } from '../src/db/items-repo.js';
import { loadConfig } from '../src/config.js';
import { createYjsStore, type YjsStore } from '../src/crdt/yjs-store.js';
import { createProjector, type Projector } from '../src/crdt/projector.js';
import { writeMove } from '@open-outliner/crdt';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const ITEM_COUNT = 10_000;
const MOVE_BUDGET_MS = 500;

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

describeDb(`QA gate: ${ITEM_COUNT}-item move responsiveness`, () => {
  let db: Db;
  let store: YjsStore;
  let projector: Projector;
  let documentId: string;
  let clock = 2_000_000;
  const now = () => clock++;
  const replicaId = 'perf-test';

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
      `INSERT INTO documents (workspace_id, title) VALUES ('00000000-0000-0000-0000-000000000000', 'perf-test') RETURNING id`,
    );
    documentId = res.rows[0].id;
    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content) VALUES ($1, $2, NULL, 'a0', 'bullet', 'root')`,
      [documentId, documentId],
    );
    await db.query(
      `INSERT INTO document_projection (document_id, source_rev, projected_rev) VALUES ($1, 0, 0)`,
      [documentId],
    );
    // Author the synthetic root into the CRDT (id = documentId, parent = the
    // sentinel) and sync it, as a real client does on first open. The
    // projector skips any row whose parent is absent from the CRDT, so the
    // 10k children keyed to the root need the root present there.
    const rootClient = headlessClient(store, documentId);
    writeMove(rootClient.doc, documentId, {
      parentId: ROOT_PARENT_SENTINEL,
      rank: 'a0',
      hlc: { wallMs: now(), counter: 0, replicaId: 'root-seed' },
    });
    await rootClient.sync();
    rootClient.destroy();

    // Seed 10,000 items under the root
    const client = headlessClient(store, documentId);
    let prevRank = 'a0';
    for (let i = 0; i < ITEM_COUNT; i++) {
      const id = randomUUID();
      const rank = rankAfter(prevRank);
      client.doc.transact(() => {
        writeMove(client.doc, id, {
          parentId: documentId,
          rank,
          hlc: { wallMs: now(), counter: i, replicaId },
        });
      });
      prevRank = rank;
    }
    await client.sync();
    await projector.projectDocument(documentId);
    client.destroy();
  });

  it(`move last item to first position completes in <${MOVE_BUDGET_MS}ms`, async () => {
    // Read current items to find the last one
    const rows = await getLiveItems(db, documentId);
    const items = rows.filter((r) => r.id !== documentId).sort((a, b) => a.rank.localeCompare(b.rank));
    expect(items.length).toBe(ITEM_COUNT);

    const lastItem = items[items.length - 1]!;
    const firstItem = items[0]!;

    // Move last item to the first position (worst case for rank generation)
    const client = headlessClient(store, documentId);
    const newRank = rankBetween(null, firstItem.rank);
    const start = performance.now();
    client.doc.transact(() => {
      writeMove(client.doc, lastItem.id, {
        parentId: documentId,
        rank: newRank,
        hlc: { wallMs: now(), counter: 0, replicaId },
      });
    });
    await client.sync();

    // Project
    const projected = await projector.projectDocument(documentId);
    const elapsed = performance.now() - start;

    expect(projected).toBe(true);
    expect(elapsed).toBeLessThan(MOVE_BUDGET_MS);

    // Verify the item moved: its rank should be < the old first item's rank
    const updatedRows = await getLiveItems(db, documentId);
    const moved = updatedRows.find((r) => r.id === lastItem.id)!;
    expect(moved.rank.localeCompare(firstItem.rank)).toBeLessThan(0);

    client.destroy();
  });
});
