import * as Y from 'yjs';
import { withDocumentLock } from '../db/db.js';
import type { Db } from '../db/db.js';

/**
 * Yjs compaction job (Phase 12 / ADR-0015).
 *
 * Incremental updates accumulate in `yjs_updates` indefinitely — room load
 * time is O(update count). Compaction snapshots the merged state and truncates
 * superseded incremental rows so load time stays bounded, without touching the
 * authoritative source-of-truth content.
 *
 * Safety: runs under the per-document advisory lock (shared with the projector
 * and GC) so it cannot race a concurrent projection pass for the same document.
 * The truncation is safe because Yjs merge is idempotent — re-applying a
 * snapshot is equivalent to replaying the original update stream.
 */

export interface CompactionWorker {
  /** Compact one document. Returns true if compaction ran (update count > threshold). */
  compactDocument(documentId: string): Promise<boolean>;
  /** Sweep all documents that exceed the compaction threshold. Returns count compacted. */
  sweep(): Promise<number>;
}

export interface CompactionConfig {
  /** Compact a document when its raw update count exceeds this. Default: 100. */
  updateThreshold?: number;
  /** Max lag between source_rev and projected_rev for OPS metrics. */
  log?: (msg: string) => void;
}

async function getUpdateCount(db: Db, documentId: string): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM yjs_updates WHERE document_id = $1`,
    [documentId],
  );
  return Number.parseInt(res.rows[0]?.n ?? '0', 10);
}

async function getDocumentsAboveThreshold(db: Db, threshold: number): Promise<string[]> {
  const res = await db.query<{ document_id: string }>(
    `SELECT document_id
       FROM yjs_updates
      GROUP BY document_id
     HAVING count(*) > $1
      LIMIT 100`,
    [threshold],
  );
  return res.rows.map((r) => r.document_id);
}

export function createCompactionWorker(db: Db, config: CompactionConfig = {}): CompactionWorker {
  const threshold = config.updateThreshold ?? 100;
  const log = config.log ?? (() => {});

  async function compactDocument(documentId: string): Promise<boolean> {
    const count = await getUpdateCount(db, documentId);
    if (count <= threshold) return false;

    return withDocumentLock(db, documentId, async (tx) => {
      const res = await tx.query<{ update: Buffer }>(
        `SELECT update FROM yjs_updates WHERE document_id = $1 ORDER BY id ASC`,
        [documentId],
      );
      if (res.rows.length <= threshold) return false;

      const doc = new Y.Doc();
      for (const row of res.rows) {
        try {
          Y.applyUpdate(doc, new Uint8Array(row.update));
        } catch {
          // skip corrupt rows
        }
      }
      const snapshot = Y.encodeStateAsUpdate(doc);
      doc.destroy();

      // Replace all incremental updates with the single snapshot, atomically.
      // The advisory lock ensures no concurrent storeUpdate or projector pass
      // races this truncation + insert.
      await tx.query(`DELETE FROM yjs_updates WHERE document_id = $1`, [documentId]);
      await tx.query(`INSERT INTO yjs_updates (document_id, update) VALUES ($1, $2)`, [
        documentId,
        Buffer.from(snapshot),
      ]);

      log(`compacted ${res.rows.length} updates → 1 snapshot for ${documentId}`);
      return true;
    });
  }

  async function sweep(): Promise<number> {
    const docs = await getDocumentsAboveThreshold(db, threshold);
    let count = 0;
    for (const documentId of docs) {
      try {
        if (await compactDocument(documentId)) count++;
      } catch (err) {
        log(
          `compaction failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return count;
  }

  return { compactDocument, sweep };
}

/** Projection-lag metric: max(source_rev - projected_rev) across all documents. */
export async function maxProjectionLag(db: Db): Promise<number> {
  const res = await db.query<{ lag: string }>(
    `SELECT COALESCE(max(source_rev - projected_rev), 0)::text AS lag FROM document_projection`,
  );
  return Number.parseInt(res.rows[0]?.lag ?? '0', 10);
}

/** Compaction-lag metric: max update count across all documents (unbounded = stale compaction). */
export async function maxCompactionLag(db: Db): Promise<number> {
  const res = await db.query<{ lag: string }>(
    `SELECT COALESCE(max(cnt), 0)::text AS lag
       FROM (SELECT count(*) AS cnt FROM yjs_updates GROUP BY document_id) t`,
  );
  return Number.parseInt(res.rows[0]?.lag ?? '0', 10);
}
