import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Forbidden } from '@hocuspocus/common';
import type { Db } from '../db/db.js';
import { createYjsStore, type YjsStore } from './yjs-store.js';
import { createProjector, type Projector } from './projector.js';
import { resolveWsConnection, startAuthHeartbeat, } from './auth.js';
import { createConnectionRegistry, type ConnectionRegistry } from './connections.js';
import { createReplicaHooks } from './replica-hooks.js';
import { ITEMS_MAP } from '@open-outliner/shared';
import { removeTombstoneKeysFromStore } from './gc-keys.js';
import { createRateLimiter, type RateLimiter } from '../http/rate-limit.js';

/**
 * The Hocuspocus collaboration server (COL) wired to the ack-after-persist
 * store (ADR-0015), the debounced materializer (ADR-0013), and the session
 * auth boundary (ADR-0014, Phase 5/SEC):
 *
 * - `onAuthenticate` resolves the session cookie forwarded on the WS upgrade
 *   to a live member of the room's document, rejecting unauthenticated,
 *   expired, revoked, or non-member connections before any Yjs state is
 *   exchanged (read-gates-the-connection, security-and-multitenancy.md).
 * - `connected`/`onDisconnect` track the connection in a registry keyed by
 *   session id, so `RemoveMember`/`Logout` (the HTTP layer) can drop a live
 *   socket the instant a session is revoked, and a periodic heartbeat
 *   catches revocations this process didn't itself observe.
 * - ADR-0019: the connection also carries the client's stable HLC replica id
 *   (a `replicaId` URL parameter, ADR-0009) and a `synced` flag. `connected`
 *   immediately writes a blocking `replica_sync` row; the client's
 *   `replica.synced` stateless ack (`onStateless`) and the disconnect/heartbeat
 *   touches advance `last_synced_at`, which is what gates tombstone-aware GC.
 * - `fetch` loads a room by replaying stored updates (corruption-tolerant).
 * - `store` durably commits each update to `yjs_updates` BEFORE Hocuspocus acks
 *   it to peers (the Database extension awaits this promise), so *acked ⇒
 *   durable*. Advancing `source_rev` here drives the projection guard.
 * - After each store, a debounced projection pass runs so a keystroke burst
 *   collapses into one pass. The catch-up sweep (started separately) recovers any
 *   pass lost to a crash in the persist→debounce gap.
 */

export interface CollabServerDeps {
  db: Db;
  replicaId: string;
  sessionCookieName: string;
  projectionDebounceMs?: number;
  authHeartbeatMs?: number;
  connectRateLimit?: { limit: number; windowMs: number };
  log?: (msg: string) => void;
}

export interface CollabServer {
  hocuspocus: Hocuspocus;
  store: YjsStore;
  projector: Projector;
  connections: ConnectionRegistry;
  connectLimiter: RateLimiter;
  stopAuthHeartbeat: () => void;
  /**
   * Author tombstone key removals into the CRDT plane (ADR-0006/0019).
   * Preferred path is a transaction on the LIVE room Document when one is
   * loaded: Hocuspocus broadcasts the deletion to connected clients and the
   * Database extension persists it. With no live room, falls back to a store
   * delta (gc-keys.ts). Callers (the GC worker) invoke this under the replica-
   * acknowledgement gate.
   */
  removeTombstoneKeys(documentId: string, itemIds: readonly string[]): Promise<void>;
}

export function createCollabServer(deps: CollabServerDeps): CollabServer {
  const { db, replicaId } = deps;
  const log = deps.log ?? (() => {});
  const debounceMs = deps.projectionDebounceMs ?? 300;

  const store = createYjsStore(db, log);
  const projector = createProjector({ db, store, replicaId, log });
  const connections = createConnectionRegistry();
  const connectLimiter = createRateLimiter(
    deps.connectRateLimit ?? { limit: 30, windowMs: 60_000 },
  );
  // ADR-0019 ledger wiring (connected/onStateless/onDisconnect), extracted so it
  // is unit-testable without a live server or database (replica-hooks.test.ts).
  const replicaHooks = createReplicaHooks({ db, connections, log });

  // Per-document debounce timers so a burst of updates yields one projection pass.
  const timers = new Map<string, NodeJS.Timeout>();
  function scheduleProjection(documentId: string): void {
    const existing = timers.get(documentId);
    if (existing) clearTimeout(existing);
    timers.set(
      documentId,
      setTimeout(() => {
        timers.delete(documentId);
        void projector.projectDocument(documentId).catch((err) => {
          log(`projection failed for ${documentId}: ${err instanceof Error ? err.message : err}`);
        });
      }, debounceMs),
    );
  }

  const hocuspocus = new Hocuspocus({
    async onAuthenticate(data) {
      try {
        const { userId, sessionId } = await resolveWsConnection(
          { db, sessionCookieName: deps.sessionCookieName, connectLimiter },
          {
            documentName: data.documentName,
            requestHeaders: data.requestHeaders,
            ip: data.request.socket.remoteAddress ?? 'unknown',
          },
        );
        return { userId, sessionId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`WS auth rejected for ${data.documentName}: ${message}`);
        // Always Forbidden (4403) for authz failures. Throwing Unauthorized
        // (4401) makes the provider print a misleading "token is required"
        // warning even when a token was sent and the cookie/session was the
        // real problem (ADR-0014 cookie auth; token is a Hocuspocus handshake
        // formality).
        throw Forbidden;
      }
    },
    connected: replicaHooks.connected,
    onStateless: replicaHooks.onStateless,
    onDisconnect: replicaHooks.onDisconnect,
    extensions: [
      new Database({
        fetch: async ({ documentName }) => {
          return store.loadDocumentState(documentName);
        },
        store: async ({ documentName, state }) => {
          // Durable ack: commit before this resolves (ADR-0015). The extension
          // awaits it, so the update is not treated as safely received until here.
          await store.storeUpdate(documentName, new Uint8Array(state));
          scheduleProjection(documentName);
        },
      }),
    ],
  });

  const heartbeat = startAuthHeartbeat(db, connections, deps.authHeartbeatMs ?? 60_000, log);

  return {
    hocuspocus,
    store,
    projector,
    connections,
    connectLimiter,
    stopAuthHeartbeat: heartbeat.stop,
    async removeTombstoneKeys(documentId, itemIds) {
      if (itemIds.length === 0) return;
      const room = hocuspocus.documents.get(documentId);
      if (room && !room.isDestroyed) {
        try {
          // Live room: a server-side transaction on the room Document. Hocuspocus
          // fires the document's onUpdate → broadcasts the deletion to every
          // connected client — without this, they would keep the tombstone key
          // until their next sync. The Database extension would eventually
          // persist it too, but behind its debounce (~2s): the GC transaction
          // below commits the row deletes immediately, so a crash inside the
          // debounce gap would lose the key deletions and the next projection
          // pass would re-upsert the tombstones with a fresh deleted_at
          // (retention silently restarting). Persist the delta directly —
          // before returning — to make broadcast and durability atomic from
          // the caller's perspective. Concurrent client updates merged into
          // the room between the two state vectors merely ride along (storing
          // an update twice is idempotent in Yjs).
          const before = Y.encodeStateVector(room);
          Y.transact(room, () => {
            const items = room.getMap(ITEMS_MAP);
            for (const id of itemIds) items.delete(id);
          });
          const delta = Y.encodeStateAsUpdate(room, before);
          if (delta.length > 0) await store.storeUpdate(documentId, delta);
          return;
        } catch (err) {
          log(
            `live-room tombstone removal failed for ${documentId}, falling back to store: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      await removeTombstoneKeysFromStore(store, documentId, itemIds);
    },
  };
}
