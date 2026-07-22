import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Forbidden, Unauthorized } from '@hocuspocus/common';
import type { Db } from '../db/db.js';
import { createYjsStore, type YjsStore } from './yjs-store.js';
import { createProjector, type Projector } from './projector.js';
import { resolveWsConnection, startAuthHeartbeat, WsAuthError } from './auth.js';
import { createConnectionRegistry, type ConnectionRegistry } from './connections.js';
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
}

export function createCollabServer(deps: CollabServerDeps): CollabServer {
  const { db, replicaId } = deps;
  const log = deps.log ?? (() => {});
  const debounceMs = deps.projectionDebounceMs ?? 300;

  const store = createYjsStore(db, log);
  const projector = createProjector({ db, store, replicaId, log });
  const connections = createConnectionRegistry();
  const connectLimiter = createRateLimiter(deps.connectRateLimit ?? { limit: 30, windowMs: 60_000 });

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
          { documentName: data.documentName, requestHeaders: data.requestHeaders, ip: data.request.socket.remoteAddress ?? 'unknown' },
        );
        return { userId, sessionId };
      } catch (err) {
        log(`WS auth rejected for ${data.documentName}: ${err instanceof Error ? err.message : String(err)}`);
        throw err instanceof WsAuthError ? Forbidden : Unauthorized;
      }
    },
    async connected(data) {
      const sessionId = (data.context as { sessionId?: string } | undefined)?.sessionId;
      if (sessionId) connections.register(data.socketId, sessionId, data.connectionInstance);
    },
    async onDisconnect(data) {
      connections.unregister(data.socketId);
    },
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
  };
}

