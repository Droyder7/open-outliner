import Dexie, { type Table } from 'dexie';

/**
 * IndexedDB-backed durable mutation outbox (offline-and-pwa.md): pending
 * API-plane writes not yet acknowledged by the server. Separate from the
 * Yjs `y-indexeddb` store (structure/text) — this only ever holds queueable
 * `/rpc` mutations (see `RPC_QUEUEABLE_METHODS`).
 *
 * Living in its own IndexedDB database (not the SW's Cache Storage) means a
 * service-worker version upgrade can never drop a non-empty outbox: SW
 * `activate`/`skipWaiting` only touches Cache Storage, never IndexedDB.
 */

export interface OutboxEntry {
  /** Auto-increment replay order — strictly monotonic, unlike `createdAt` (two
   * enqueues in the same millisecond would otherwise tie and could replay out
   * of order, which matters for two queued edits to the same item). */
  seq?: number;
  requestId: string;
  method: string;
  params: unknown;
  createdAt: number;
}

class OfflineDb extends Dexie {
  outbox!: Table<OutboxEntry, number>;

  constructor() {
    super('oo-offline');
    this.version(1).stores({
      outbox: '++seq, requestId, createdAt',
    });
  }
}

export const offlineDb = new OfflineDb();
