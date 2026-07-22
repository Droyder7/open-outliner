import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { createCollabServer } from './crdt/server.js';
import { createHttpServer } from './http/server.js';

/**
 * Process entrypoint: applies pending migrations, then brings up the two
 * network surfaces that make up the app server —
 *
 * - the `/rpc` HTTP API (Phase 6) on `config.port`
 * - the Hocuspocus collaboration WebSocket (Phase 3/5) on `config.wsPort`
 *
 * — sharing one `Db` pool and one connection registry so a session revoked
 * through `/rpc` (`Logout`/`RemoveMember`) drops its live Hocuspocus socket
 * immediately (ADR-0014), not just on the next heartbeat tick.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const log = (msg: string) => console.log(`[server] ${msg}`);

  log(`Applying migrations from ${config.migrationsDir} …`);
  const migrated = await migrate(db, config.migrationsDir);
  if (migrated.applied.length > 0) {
    log(`Applied ${migrated.applied.length} migration(s): ${migrated.applied.map((m) => m.name).join(', ')}`);
  }

  const collab = createCollabServer({
    db,
    replicaId: config.replicaId,
    sessionCookieName: config.sessionCookieName,
    authHeartbeatMs: config.authHeartbeatMs,
    connectRateLimit: config.connectRateLimit,
    log,
  });

  const http = createHttpServer({
    db,
    config,
    log,
    onSessionsRevoked: (sessionIds) => {
      for (const sessionId of sessionIds) collab.connections.closeSession(sessionId);
    },
  });

  // Catch-up sweep (ADR-0013): recovers any projection pass lost to a crash in
  // the persist→debounce gap. Runs once at startup, then on an interval.
  const sweepTimer = setInterval(() => {
    void collab.projector.sweep().catch((err) => {
      log(`projection sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.projectionSweepMs);
  sweepTimer.unref();
  void collab.projector.sweep().catch((err) => {
    log(`initial projection sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  await collab.hocuspocus.listen(config.wsPort);
  log(`Hocuspocus collaboration server listening on :${config.wsPort}`);

  await new Promise<void>((resolve) => http.server.listen(config.port, resolve));
  log(`/rpc HTTP API listening on :${config.port}`);

  async function shutdown(signal: string): Promise<void> {
    log(`${signal} received, shutting down …`);
    clearInterval(sweepTimer);
    collab.stopAuthHeartbeat();
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    await collab.hocuspocus.destroy();
    await db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
