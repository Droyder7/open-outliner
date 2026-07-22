import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createUser, createWorkspace, addMember } from '../src/db/tenancy-repo.js';
import { createSession, revokeSession } from '../src/db/sessions-repo.js';
import { resolveWsConnection, startAuthHeartbeat, WsAuthError } from '../src/crdt/auth.js';
import { createConnectionRegistry } from '../src/crdt/connections.js';
import { createRateLimiter } from '../src/http/rate-limit.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Hocuspocus WS auth + revocation (SEC, Phase 5)', () => {
  let db: Db;
  const config = loadConfig();

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function deps() {
    return {
      db,
      sessionCookieName: config.sessionCookieName,
      connectLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    };
  }

  it('rejects a connection with no session cookie', async () => {
    await expect(
      resolveWsConnection(deps(), { documentName: 'doc-x', requestHeaders: {}, ip: '1.2.3.4' }),
    ).rejects.toBeInstanceOf(WsAuthError);
  });

  it('rejects an invalid/expired session cookie', async () => {
    await expect(
      resolveWsConnection(deps(), {
        documentName: 'doc-x',
        requestHeaders: { cookie: `${config.sessionCookieName}=not-a-real-session` },
        ip: '1.2.3.4',
      }),
    ).rejects.toBeInstanceOf(WsAuthError);
  });

  it('accepts a member and rejects a non-member for the same document', async () => {
    const ownerId = await createUser(db, `wsowner-${crypto.randomUUID()}@e.test`, null, 'h');
    const memberId = await createUser(db, `wsmember-${crypto.randomUUID()}@e.test`, null, 'h');
    const strangerId = await createUser(db, `wsstranger-${crypto.randomUUID()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'WS');
    await addMember(db, workspaceId, memberId);
    const doc = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ($1, 'Doc') RETURNING id`,
      [workspaceId],
    );
    const documentId = doc.rows[0]!.id;

    const memberSessionId = await createSession(db, memberId, config.sessionTtlMs);
    const result = await resolveWsConnection(deps(), {
      documentName: documentId,
      requestHeaders: { cookie: `${config.sessionCookieName}=${memberSessionId}` },
      ip: '1.2.3.4',
    });
    expect(result).toEqual({ userId: memberId, sessionId: memberSessionId });

    const strangerSessionId = await createSession(db, strangerId, config.sessionTtlMs);
    await expect(
      resolveWsConnection(deps(), {
        documentName: documentId,
        requestHeaders: { cookie: `${config.sessionCookieName}=${strangerSessionId}` },
        ip: '1.2.3.4',
      }),
    ).rejects.toBeInstanceOf(WsAuthError);
  });

  it('rejects a revoked session even though the cookie value still exists', async () => {
    const userId = await createUser(db, `wsrevoked-${crypto.randomUUID()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, userId, 'WS');
    const doc = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ($1, 'Doc') RETURNING id`,
      [workspaceId],
    );
    const documentId = doc.rows[0]!.id;
    const sessionId = await createSession(db, userId, config.sessionTtlMs);
    await revokeSession(db, sessionId);

    await expect(
      resolveWsConnection(deps(), {
        documentName: documentId,
        requestHeaders: { cookie: `${config.sessionCookieName}=${sessionId}` },
        ip: '1.2.3.4',
      }),
    ).rejects.toBeInstanceOf(WsAuthError);
  });

  it('connection registry: closeSession force-closes every socket for a session', () => {
    const registry = createConnectionRegistry();
    const closed: string[] = [];
    const fakeConn = (id: string) => ({ close: () => closed.push(id) }) as unknown as import('@hocuspocus/server').Connection;

    registry.register('socket-1', 'session-A', fakeConn('socket-1'));
    registry.register('socket-2', 'session-A', fakeConn('socket-2'));
    registry.register('socket-3', 'session-B', fakeConn('socket-3'));

    registry.closeSession('session-A');
    expect(closed.sort()).toEqual(['socket-1', 'socket-2']);

    // closeSession only calls .close() — actual removal from the registry
    // happens when Hocuspocus's onDisconnect hook fires for the closed
    // socket (crdt/server.ts), simulated here explicitly.
    registry.unregister('socket-1');
    registry.unregister('socket-2');
    registry.unregister('socket-3');
    expect(registry.liveSessionIds()).toEqual([]);
  });

  it('the periodic heartbeat drops a connection whose session was revoked out-of-band', async () => {
    const userId = await createUser(db, `heartbeat-${crypto.randomUUID()}@e.test`, null, 'h');
    await createWorkspace(db, userId, 'WS');
    const sessionId = await createSession(db, userId, config.sessionTtlMs);

    const registry = createConnectionRegistry();
    const closed: string[] = [];
    // Simulates the real Connection: closing it eventually fires onDisconnect,
    // which unregisters the socket (crdt/server.ts) — without that, the
    // heartbeat would keep re-closing an already-closed, still-tracked socket.
    registry.register('sock', sessionId, {
      close: () => {
        closed.push(sessionId);
        registry.unregister('sock');
      },
    } as unknown as import('@hocuspocus/server').Connection);

    // Revoke "out of band" (e.g. another node, or a direct admin action) —
    // the heartbeat, not closeSession, is what must notice this one.
    await revokeSession(db, sessionId);

    const heartbeat = startAuthHeartbeat(db, registry, 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(closed).toEqual([sessionId]);
    } finally {
      heartbeat.stop();
    }
  });
});
