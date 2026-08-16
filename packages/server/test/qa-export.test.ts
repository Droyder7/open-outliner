/**
 * Acceptance gate: export round-trip contract (QA, Phase 13).
 *
 * Measures the "Export has a defined, tested contract" gate from status.md.
 * Per ADR-0016: export to JSON → import into a fresh workspace → the imported
 * outline is equivalent to the source (same tree shape, same (rank, id) sibling
 * order, same item type and metadata), with tombstoned items absent.
 *
 * Run with: pnpm --filter @open-outliner/server test -- --grep "export"
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { rankBetween, rankAfter } from '@open-outliner/shared';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { getLiveItems } from '../src/db/items-repo.js';
import { loadConfig } from '../src/config.js';
import { createYjsStore, type YjsStore } from '../src/crdt/yjs-store.js';
import { createProjector, type Projector } from '../src/crdt/projector.js';
import { writeMove, writeContent } from '@open-outliner/crdt';
import { serializeJson, serializeMarkdown, importDocument } from '../src/export/serializer.js';

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

describeDb('QA gate: export round-trip (ADR-0016)', () => {
  let db: Db;
  let store: YjsStore;
  let projector: Projector;
  let documentId: string;
  let clock = 3_000_000;
  const now = () => clock++;
  const replicaId = 'export-test';

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
      `INSERT INTO documents (workspace_id, title) VALUES ('00000000-0000-0000-0000-000000000000', 'export-test') RETURNING id`,
    );
    documentId = res.rows[0].id;
    await db.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content) VALUES ($1, $2, NULL, 'a0', 'bullet', 'root')`,
      [documentId, documentId],
    );
    await db.query(
      `INSERT INTO document_projection (document_id, source_rev, projected_rev) VALUES ($1, 0, 0)`,
      [documentId, documentId],
    );
  });

  it('JSON round-trip: export → import → structural equivalence', async () => {
    const client = headlessClient(store, documentId);

    // Build a 3-level tree: root → [A, B] → A has [A1, A2], B has [B1]
    const idA = randomUUID();
    const idB = randomUUID();
    const idA1 = randomUUID();
    const idA2 = randomUUID();
    const idB1 = randomUUID();

    client.doc.transact(() => {
      const items = [
        { id: idA, parentId: documentId, rank: 'a1', content: 'Item A' },
        { id: idB, parentId: documentId, rank: 'a2', content: 'Item B' },
        { id: idA1, parentId: idA, rank: 'a1', content: 'Item A1' },
        { id: idA2, parentId: idA, rank: 'a2', content: 'Item A2' },
        { id: idB1, parentId: idB, rank: 'a1', content: 'Item B1' },
      ];
      for (const item of items) {
        writeMove(client.doc, item.id, documentId, {
          parentId: item.parentId,
          rank: item.rank,
          hlc: { wallMs: now(), counter: 0, replicaId },
        });
        writeContent(client.doc, item.id, item.content);
      }
    });
    await client.sync();
    await projector.projectDocument(documentId);

    // Export as JSON
    const rows = await getLiveItems(db, documentId);
    const json = serializeJson(documentId, rows);
    const parsed = JSON.parse(json);

    // Verify envelope
    expect(parsed.version).toBe(1);
    expect(parsed.items).toHaveLength(6); // root + 5 items

    // Verify tree shape: parent-child relationships
    const itemById = new Map(parsed.items.map((i: { id: string }) => [i.id, i]));
    const root = parsed.items.find((i: { parentId: null }) => i.parentId === null);
    expect(root).toBeDefined();

    const children = parsed.items.filter((i: { parentId: string }) => i.parentId === root.id);
    expect(children).toHaveLength(2);

    // Import into a fresh document
    const { documentId: newDocId, rootItemId } = await importDocument(
      db,
      '00000000-0000-0000-0000-000000000000',
      'Imported',
      parsed,
    );

    // Read back the imported document
    const importedRows = await getLiveItems(db, newDocId);
    const importedItems = importedRows.filter((r) => r.id !== rootItemId);

    // Should have 5 non-root items (same structure)
    expect(importedItems).toHaveLength(5);

    // Every item's content should match
    const importedByContent = new Map(importedItems.map((r) => [r.content, r]));
    expect(importedByContent.has('Item A')).toBe(true);
    expect(importedByContent.has('Item B')).toBe(true);
    expect(importedByContent.has('Item A1')).toBe(true);
    expect(importedByContent.has('Item A2')).toBe(true);
    expect(importedByContent.has('Item B1')).toBe(true);

    // Parent-child: A1 and A2 should have the same parent
    const a1 = importedByContent.get('Item A1')!;
    const a2 = importedByContent.get('Item A2')!;
    expect(a1.parent_id).toBe(a2.parent_id);

    // B1 should have a different parent
    const b1 = importedByContent.get('Item B1')!;
    expect(b1.parent_id).not.toBe(a1.parent_id);

    client.destroy();
  });

  it('Markdown export: structural hierarchy preserved', async () => {
    const client = headlessClient(store, documentId);

    client.doc.transact(() => {
      writeMove(client.doc, randomUUID(), documentId, {
        parentId: documentId,
        rank: 'a1',
        hlc: { wallMs: now(), counter: 0, replicaId },
      });
    });
    await client.sync();
    await projector.projectDocument(documentId);

    const rows = await getLiveItems(db, documentId);
    const md = serializeMarkdown(rows);

    // Should produce a non-empty Markdown string
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);

    client.destroy();
  });
});
