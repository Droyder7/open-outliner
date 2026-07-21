import pg from 'pg';

const { Pool } = pg;

export type QueryParam = string | number | boolean | null | Date | Buffer | Uint8Array;

export interface Db {
  /** Run a parameterized query. Never string-concatenate SQL. */
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<pg.QueryResult<Row>>;
  /**
   * Run `fn` inside a transaction, committing on success and rolling back on
   * throw. The callback receives a client bound to a single connection — use it
   * for the projector's advisory-lock + upsert + projected_rev advance so they
   * commit atomically (ADR-0013).
   */
  transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

export interface TxClient {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<pg.QueryResult<Row>>;
}

export function createDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    pool,
    async query(text, params) {
      return pool.query(text, params as QueryParam[] | undefined);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (text, params) => client.query(text, params as QueryParam[] | undefined),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Take the per-document advisory lock (`hashtext(document_id)`) for the duration
 * of `fn`, run inside a transaction so the lock is transaction-scoped and auto-
 * released on commit/rollback. This is the single serialization point shared by
 * the projector, compaction, and GC (ADR-0004/0013/0015).
 */
export async function withDocumentLock<T>(
  db: Db,
  documentId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
    return fn(tx);
  });
}
