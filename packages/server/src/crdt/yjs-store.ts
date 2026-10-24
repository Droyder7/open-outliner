import * as Y from 'yjs';
import type { Db } from '../db/db.js';

/**
 * Yjs persistence store: ack-after-persist to `yjs_updates` (ADR-0015).
 *
 * The durable-ack rule: an update is only considered received once it is durably
 * committed here. The store is replay-tolerant (Yjs merge is idempotent), so no
 * per-update dedup or ordering check is needed — duplicates cost only load time,
 * which compaction (Phase 12) bounds. `source_rev` advances on every committed
 * update (a per-document generation, independent of row allocation order), driving the projection revision guard
 * (ADR-0013).
 *
 * This module is transport-agnostic: the Hocuspocus Database extension calls
 * `storeUpdate`/`loadDocumentState`; tests call them directly (the headless
 * spine proof).
 */

export interface DocumentSnapshot {
  doc: Y.Doc;
  /** Per-document committed generation, read in the same SQL snapshot as updates. */
  revision: number;
}

export interface YjsStore {
  loadDocumentSnapshot(documentId: string, strict?: boolean): Promise<DocumentSnapshot>;
  /**
   * Durably persist one incremental update and advance the document's
   * `source_rev` in the SAME transaction, so an acked update is always reflected
   * in the revision the projector reads. Returns the new `source_rev`.
   */
  storeUpdate(documentId: string, update: Uint8Array): Promise<number>;
  /**
   * Load the merged state for a document by replaying all stored updates. A row
   * that fails to apply is skipped and logged (corruption tolerance, ADR-0015);
   * the rest still reconstruct the room. Returns null if there is no state yet.
   */
  loadDocumentState(documentId: string): Promise<Uint8Array | null>;
  /** Apply stored updates onto a fresh Y.Doc and return it. */
  loadDocument(documentId: string): Promise<Y.Doc>;
}

export function createYjsStore(db: Db, log: (msg: string) => void = () => {}): YjsStore {
  return {
    async storeUpdate(documentId, update) {
      return db.transaction(async (tx) => {
        await tx.query(`INSERT INTO yjs_updates (document_id, update) VALUES ($1, $2)`, [
          documentId,
          Buffer.from(update),
        ]);
        // Advance a committed generation. Upsert the projection row so a
        // brand-new document (no createDocument seed) still tracks correctly.
        const res = await tx.query<{ source_rev: string }>(
          `INSERT INTO document_projection (document_id, source_rev, projected_rev)
           VALUES ($1, 1, 0)
           ON CONFLICT (document_id) DO UPDATE
             SET source_rev = document_projection.source_rev + 1,
                 updated_at = now()
           RETURNING source_rev`,
          [documentId],
        );
        return Number.parseInt(res.rows[0]!.source_rev, 10);
      });
    },

    async loadDocumentState(documentId) {
      const doc = await this.loadDocument(documentId);
      const hasContent = doc.getMap('items').size > 0;
      const state = hasContent ? Y.encodeStateAsUpdate(doc) : null;
      doc.destroy();
      return state;
    },

    async loadDocument(documentId) {
      return (await this.loadDocumentSnapshot(documentId, false)).doc;
    },

    async loadDocumentSnapshot(documentId, strict = true) {
      // One statement: rows and generation must describe the same MVCC snapshot.
      const res = await db.query<{ update: Buffer; revision: string }>(
        `SELECT u.update, p.source_rev AS revision
           FROM yjs_updates u JOIN document_projection p ON p.document_id = u.document_id
          WHERE u.document_id = $1 ORDER BY u.id ASC`,
        [documentId],
      );
      const doc = new Y.Doc();
      try {
        for (const row of res.rows) {
          try {
            Y.applyUpdate(doc, new Uint8Array(row.update));
          } catch (err) {
            log(`corrupt yjs_updates row for ${documentId}: ${String(err)}`);
            if (strict) throw err;
          }
        }
        return { doc, revision: Number(res.rows[0]?.revision ?? 0) };
      } catch (err) {
        doc.destroy();
        throw err;
      }
    },
  };
}
