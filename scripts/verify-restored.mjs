import { createDb } from '../packages/server/dist/db/db.js';
import { createYjsStore } from '../packages/server/dist/crdt/yjs-store.js';
import { readAllSnapshots } from '../packages/crdt/dist/index.js';
const target = process.env.RESTORE_DATABASE;
if (!target || !/^outliner_restore_[a-z0-9_]+$/.test(target))
  throw new Error('Unsafe restore target');
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${target}`;
const db = createDb(url.toString());
try {
  const invalid = await db.query(`SELECT count(*)::int AS n FROM items i
    LEFT JOIN documents d ON d.id=i.document_id
    LEFT JOIN items p ON p.id=i.parent_id
    WHERE d.id IS NULL OR (i.parent_id IS NOT NULL AND (p.id IS NULL OR p.document_id<>i.document_id))`);
  if (invalid.rows[0].n) throw new Error('Restored document boundaries are invalid');
  const generations = await db.query(
    'SELECT count(*)::int AS n FROM document_projection WHERE projected_rev>source_rev',
  );
  if (generations.rows[0].n) throw new Error('Restored revision boundary is invalid');
  const store = createYjsStore(db);
  const docs = await db.query('SELECT id FROM documents ORDER BY id');
  let items = 0;
  let matched = !process.env.RESTORE_DOCUMENT_ID;
  for (const { id } of docs.rows) {
    const { doc } = await store.loadDocumentSnapshot(id);
    try {
      const nodes = readAllSnapshots(doc);
      items += nodes.length;
      if (id === process.env.RESTORE_DOCUMENT_ID) {
        const expected = process.env.RESTORE_EXPECT_TEXT;
        if (!expected || !nodes.some((n) => n.content === expected || n.note === expected))
          throw new Error('Known outline content missing from restored Yjs state');
        const projection = await db.query(
          'SELECT id FROM items WHERE document_id=$1 AND content=$2',
          [id, expected],
        );
        if (!projection.rows.length)
          throw new Error('Known outline content missing from restored projection');
        matched = true;
      }
    } finally {
      doc.destroy();
    }
  }
  if (!matched) throw new Error('Known document missing from restored database');
  const receipts = await db.query('SELECT count(*)::int AS n FROM document_update_receipts');
  console.log(
    JSON.stringify({
      documents: docs.rows.length,
      yjsItems: items,
      receipts: receipts.rows[0].n,
      verified: true,
    }),
  );
} finally {
  await db.close();
}
