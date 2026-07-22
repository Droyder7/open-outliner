import type { Connection } from '@hocuspocus/server';
import { Unauthorized } from '@hocuspocus/common';

/**
 * Registry of live, authenticated Hocuspocus connections keyed by the
 * session that authenticated them. Revocation (ADR-0014: removing a member,
 * logging out) must "drop the live WebSocket" immediately — not just wait
 * for the next heartbeat re-auth tick — so `RemoveMember`/`Logout` call
 * `closeSession` right after they invalidate the session row.
 */
export interface ConnectionRegistry {
  register(socketId: string, sessionId: string, connection: Connection): void;
  unregister(socketId: string): void;
  /** Force-close every live connection for a revoked session. */
  closeSession(sessionId: string): void;
  /** All currently-tracked session ids (for the periodic re-auth heartbeat). */
  liveSessionIds(): string[];
}

export function createConnectionRegistry(): ConnectionRegistry {
  const bySocket = new Map<string, { sessionId: string; connection: Connection }>();
  const bySession = new Map<string, Set<string>>();

  return {
    register(socketId, sessionId, connection) {
      bySocket.set(socketId, { sessionId, connection });
      let sockets = bySession.get(sessionId);
      if (!sockets) {
        sockets = new Set();
        bySession.set(sessionId, sockets);
      }
      sockets.add(socketId);
    },
    unregister(socketId) {
      const entry = bySocket.get(socketId);
      if (!entry) return;
      bySocket.delete(socketId);
      const sockets = bySession.get(entry.sessionId);
      sockets?.delete(socketId);
      if (sockets && sockets.size === 0) bySession.delete(entry.sessionId);
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
  };
}
