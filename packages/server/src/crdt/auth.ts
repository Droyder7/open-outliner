import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from '../db/db.js';
import { resolveSession } from '../db/sessions-repo.js';
import { canAccessDocument } from '../db/tenancy-repo.js';
import { parseCookies } from '../http/cookies.js';
import type { RateLimiter } from '../http/rate-limit.js';
import type { ConnectionRegistry } from './connections.js';

/**
 * WS auth (ADR-0014): the client's session cookie is sent automatically on
 * the WebSocket upgrade handshake (cookies are scoped by domain+path, not
 * port, so this works even when Hocuspocus listens on a different port than
 * the `/rpc` HTTP server). `onAuthenticate` resolves it to a live member of
 * the room's document — reusing the exact same `resolveSession` check the
 * REST edge uses, so revocation is effective here with no separate lag.
 */

export class WsAuthError extends Error {}

export interface WsAuthDeps {
  db: Db;
  sessionCookieName: string;
  connectLimiter: RateLimiter;
}

export interface WsAuthResult {
  userId: string;
  sessionId: string;
}

export async function resolveWsConnection(
  deps: WsAuthDeps,
  params: { documentName: string; requestHeaders: IncomingHttpHeaders; ip: string },
): Promise<WsAuthResult> {
  if (!deps.connectLimiter.check(params.ip)) {
    throw new WsAuthError('Too many connection attempts, try again later');
  }
  const cookies = parseCookies(params.requestHeaders.cookie);
  const sessionId = cookies[deps.sessionCookieName];
  if (!sessionId) throw new WsAuthError('No session cookie presented');

  const resolved = await resolveSession(deps.db, sessionId);
  if (!resolved) throw new WsAuthError('Session is invalid, expired, or revoked');

  // documentName is the Hocuspocus room name, which the client sets to the
  // document id (session.ts). Membership in the owning workspace gates the
  // connection (security-and-multitenancy.md: read authorization gates the
  // connection). Reject non-UUID room names before the SQL layer so a stray
  // `?doc=smoke-test-1` becomes a clean Forbidden, not a 500 from Postgres.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      params.documentName,
    )
  ) {
    throw new WsAuthError('Document id is not a valid UUID');
  }
  const allowed = await canAccessDocument(deps.db, params.documentName, resolved.userId);
  if (!allowed) throw new WsAuthError('Not a member of the workspace that owns this document');

  return { userId: resolved.userId, sessionId };
}

/**
 * Periodic re-auth heartbeat (ADR-0014): a session can be revoked while its
 * socket stays open (membership removal races an idle connection). Every
 * tick, re-resolve every currently-tracked session and drop any that no
 * longer validate — this is the backstop for revocations this process
 * didn't itself observe (e.g. a multi-node deployment revoking via a
 * different app instance); same-process revocations are dropped immediately
 * via `ConnectionRegistry.closeSession` instead of waiting for this tick.
 */
export function startAuthHeartbeat(
  db: Db,
  registry: ConnectionRegistry,
  intervalMs: number,
  log: (msg: string) => void = () => {},
): { stop: () => void } {
  const timer = setInterval(() => {
    void (async () => {
      for (const sessionId of registry.liveSessionIds()) {
        try {
          const resolved = await resolveSession(db, sessionId);
          if (!resolved) registry.closeSession(sessionId);
        } catch (err) {
          log(
            `auth heartbeat check failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
