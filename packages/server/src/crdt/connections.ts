import type { Connection } from '@hocuspocus/server';
import { Unauthorized } from '@hocuspocus/common';

/**
 * Registry of live, authenticated Hocuspocus connections keyed by the
 * session that authenticated them. Revocation (ADR-0014: removing a member,
 * logging out) must "drop the live WebSocket" immediately — not just wait
 * for the next heartbeat re-auth tick — so `RemoveMember`/`Logout` call
 * `closeSession` right after they invalidate the session row.
 *
 * Since ADR-0019 the registry also carries, per socket, the document the
 * connection is attached to and the client's replica id (the HLC tie-breaker
 * from ADR-0009), plus a `synced` flag set when the client acknowledges a
 * completed sync. The replica-ack heartbeat (replica-heartbeat.ts) refreshes
 * `replica_sync` from the synced subset of live connections — a connection
 * that has completed its initial sync has received everything the server
 * broadcast up to that point, which is exactly the acknowledgement GC needs.
 */
export interface RegisteredConnection {
  socketId: string;
  sessionId: string;
  documentName: string;
  /** Stable client replica id (ADR-0009 `oo:replicaId`); undefined for clients that don't send it. */
  replicaId?: string;
  /** True once the client acknowledged a completed sync (ADR-0019 stateless ack). */
  synced: boolean;
  connection: Connection;
}

export interface ConnectionRegistry {
  register(socketId: string, sessionId: string, documentName: string, replicaId: string | undefined, connection: Connection): void;
  /** Drop a socket; returns the removed entry (callers may want its document/replica for a disconnect heartbeat). */
  unregister(socketId: string): RegisteredConnection | undefined;
  /**
   * Mark a socket as having completed its initial sync (ADR-0019
   * `replica.synced`). Returns the updated entry so callers (the `onStateless`
   * handler) can immediately persist the acknowledgement.
   */
  markSynced(socketId: string): RegisteredConnection | undefined;
  /** Force-close every live connection for a revoked session. */
  closeSession(sessionId: string): void;
  /** All currently-tracked session ids (for the periodic re-auth heartbeat). */
  liveSessionIds(): string[];
  /** All currently-tracked connections (for the periodic replica-ack heartbeat). */
  liveConnections(): RegisteredConnection[];
}

export function createConnectionRegistry(): ConnectionRegistry {
  const bySocket = new Map<string, RegisteredConnection>();
  const bySession = new Map<string, Set<string>>();

  return {
    register(socketId, sessionId, documentName, replicaId, connection) {
      bySocket.set(socketId, {
        socketId,
        sessionId,
        documentName,
        // exactOptionalPropertyTypes: omit the key entirely for legacy clients.
        ...(replicaId !== undefined ? { replicaId } : {}),
        synced: false,
        connection,
      });
      let sockets = bySession.get(sessionId);
      if (!sockets) {
        sockets = new Set();
        bySession.set(sessionId, sockets);
      }
      sockets.add(socketId);
    },
    unregister(socketId) {
      const entry = bySocket.get(socketId);
      if (!entry) return undefined;
      bySocket.delete(socketId);
      const sockets = bySession.get(entry.sessionId);
      sockets?.delete(socketId);
      if (sockets && sockets.size === 0) bySession.delete(entry.sessionId);
      return entry;
    },
    markSynced(socketId) {
      const entry = bySocket.get(socketId);
      if (!entry) return undefined;
      entry.synced = true;
      return entry;
    },
    closeSession(sessionId) {
      const sockets = bySession.get(sessionId);
      if (!sockets) return;
      for (const socketId of sockets) {
        bySocket.get(socketId)?.connection.close(Unauthorized);
      }
    },
    liveSessionIds() {
      return [...bySession.keys()];
    },
    liveConnections() {
      return [...bySocket.values()];
    },
  };
}
