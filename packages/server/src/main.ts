import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { createCollabServer } from './crdt/server.js';
import { createHttpServer } from './http/server.js';
import { createS3Service } from './storage/s3.js';
import { createCompactionWorker } from './jobs/compaction.js';
import { createGcWorker } from './jobs/gc.js';
import { startReplicaHeartbeat } from './crdt/replica-heartbeat.js';

/**
 * Process entrypoint: applies pending migrations, then brings up the two
 * network surfaces (HTTP /rpc + Hocuspocus WebSocket) plus background jobs
 * (projection sweep, compaction, tombstone-aware GC).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const log = (msg: string) => console.log(`[server] ${msg}`);

  log(`Applying migrations from ${config.migrationsDir} …`);
  const migrated = await migrate(db, config.migrationsDir);
  if (migrated.applied.length > 0) {
    log(
      `Applied ${migrated.applied.length} migration(s): ${migrated.applied.map((m) => m.name).join(', ')}`,
    );
  }

  // S3 service is optional — attachment RPCs return "not configured" when absent.
  const s3 =
    config.s3Endpoint && config.s3AccessKeyId && config.s3SecretAccessKey
      ? createS3Service({
          endpoint: config.s3Endpoint,
          region: config.s3Region ?? 'us-east-1',
          bucket: config.s3Bucket ?? 'open-outliner',
          accessKeyId: config.s3AccessKeyId,
          secretAccessKey: config.s3SecretAccessKey,
        })
      : undefined;
  if (s3) log('S3 attachment storage enabled');

  const collab = createCollabServer({
    db,
    replicaId: config.replicaId,
    sessionCookieName: config.sessionCookieName,
    authHeartbeatMs: config.authHeartbeatMs,
    connectRateLimit: config.connectRateLimit,
    log,
  });

  const gcWorker = createGcWorker(
    db,
    {
      retentionMs: config.gcRetentionMs,
      batchSize: 500,
      // ADR-0006/0019: hard-delete removes the item's Yjs key too (live room
      // when loaded, store delta otherwise), so projection can't re-upsert it.
      removeTombstoneKeys: (documentId, itemIds) =>
        collab.removeTombstoneKeys(documentId, itemIds),
      // In-process supplement to the replica_sync gate (ADR-0019).
      liveConnections: () => collab.connections.liveConnections(),
      // Stale-replica policy: forget replicas not seen for the TTL (bounds
      // ledger growth; auto-heals a lost sync-ack that would otherwise block
      // GC forever). Returning replicas re-register + re-gate on connect.
      replicaStaleTtlMs: config.replicaStaleTtlMs,
      log,
    },
    s3,
  );
  const compactionWorker = createCompactionWorker(db, { log });

  // Replica-ack heartbeat (ADR-0019): keeps `replica_sync.last_synced_at` fresh
  // for live, already-synced connections so GC isn't blocked by clients that
  // stay connected and idle.
  const replicaHeartbeat = startReplicaHeartbeat(
    db,
    collab.connections,
    config.replicaHeartbeatMs,
    log,
  );

  const http = createHttpServer({
    db,
    config,
    s3,
    gcWorker,
    log,
    onSessionsRevoked: (sessionIds) => {
      for (const sessionId of sessionIds) collab.connections.closeSession(sessionId);
    },
  });

  // Background jobs
  const timers: NodeJS.Timeout[] = [];

  // Projection sweep (ADR-0013).
  const sweepTimer = setInterval(() => {
    void collab.projector.sweep().catch((err) => {
      log(`projection sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.projectionSweepMs);
  sweepTimer.unref();
  timers.push(sweepTimer);
  void collab.projector.sweep().catch((err) => {
    log(`initial projection sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Compaction sweep (ADR-0015 / Phase 12).
  const compactionTimer = setInterval(() => {
    void compactionWorker.sweep().catch((err) => {
      log(`compaction sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.compactionIntervalMs);
  compactionTimer.unref();
  timers.push(compactionTimer);

  // Tombstone-aware GC (ADR-0006 / Phase 9).
  const gcTimer = setInterval(() => {
    void gcWorker.run().catch((err) => {
      log(`GC pass failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.gcIntervalMs);
  gcTimer.unref();
  timers.push(gcTimer);

  await collab.hocuspocus.listen(config.wsPort);
  log(`Hocuspocus collaboration server listening on :${config.wsPort}`);

  await new Promise<void>((resolve) => http.server.listen(config.port, resolve));
  log(`/rpc HTTP API listening on :${config.port}`);

  async function shutdown(signal: string): Promise<void> {
    log(`${signal} received, shutting down …`);
    for (const t of timers) clearInterval(t);
    collab.stopAuthHeartbeat();
    replicaHeartbeat.stop();
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
