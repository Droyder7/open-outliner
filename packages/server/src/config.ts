import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  wsPort: number;
  migrationsDir: string;
  sessionCookieName: string;
  csrfCookieName: string;
  sessionTtlMs: number;
  projectionSweepMs: number;
  authHeartbeatMs: number;
  /** Replica-ack heartbeat: refresh `replica_sync` from live connections (ms). Default: 15 000. */
  replicaHeartbeatMs: number;
  defaultDocDepth: number;
  defaultChildrenDepth: number;
  loginRateLimit: { limit: number; windowMs: number };
  presignRateLimit: { limit: number; windowMs: number };
  connectRateLimit: { limit: number; windowMs: number };
  replicaId: string;
  corsOrigin?: string;
  /** GC: interval between hard-delete passes (ms). Default: 60 000. */
  gcIntervalMs: number;
  /** GC: minimum age of deleted_at before a row may be hard-deleted (ms). Default: 7 days. */
  gcRetentionMs: number;
  /** GC: prune replica_sync rows not seen for this long (ms). Default: 14 days. */
  replicaStaleTtlMs: number;
  /** GC: max never-acked (`last_synced_at IS NULL`) replica_sync rows per document. Default: 64. */
  replicaNeverAckedCap: number;
  /** Compaction: interval between sweep passes (ms). Default: 60 000. */
  compactionIntervalMs: number;
  /** S3 endpoint URL (e.g. http://localhost:9000). Set to enable attachment storage. */
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function intEnv(name: string, fallback: number, min = 1): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  // Every int knob here is a count or an interval: 0/negative values (e.g.
  // REPLICA_HEARTBEAT_MS=0 → a DB-write busy loop on setInterval) are
  // misconfiguration, not a valid "disable" — clamp instead of spinning.
  return Math.max(min, n);
}

let cachedDefaultMigrationsDir: string | undefined;

/**
 * Resolve the repo /migrations directory relative to this file at runtime.
 * This file lives at packages/server/(src|dist)/config.*, so the repo root is
 * three directories up. Works from both tsx (src) and node (dist).
 */
function defaultMigrationsDir(): string {
  if (cachedDefaultMigrationsDir) return cachedDefaultMigrationsDir;
  cachedDefaultMigrationsDir = new URL('../../../migrations', import.meta.url).pathname;
  return cachedDefaultMigrationsDir;
}

export function loadConfig(): ServerConfig {
  const corsOrigin = process.env.CORS_ORIGIN || undefined;
  const s3Endpoint = process.env.S3_ENDPOINT || undefined;
  return {
    databaseUrl: env('DATABASE_URL', 'postgres://outliner:outliner@localhost:5432/outliner'),
    port: intEnv('PORT', 8787),
    wsPort: intEnv('WS_PORT', 8788),
    migrationsDir: env('MIGRATIONS_DIR', defaultMigrationsDir()),
    sessionCookieName: env('SESSION_COOKIE_NAME', 'oo_session'),
    csrfCookieName: env('CSRF_COOKIE_NAME', 'oo_csrf'),
    sessionTtlMs: intEnv('SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 30),
    projectionSweepMs: intEnv('PROJECTION_SWEEP_MS', 10_000),
    authHeartbeatMs: intEnv('AUTH_HEARTBEAT_MS', 60_000),
    replicaHeartbeatMs: intEnv('REPLICA_HEARTBEAT_MS', 15_000),
    defaultDocDepth: intEnv('DEFAULT_DOC_DEPTH', 2),
    defaultChildrenDepth: intEnv('DEFAULT_CHILDREN_DEPTH', 1),
    loginRateLimit: {
      limit: intEnv('LOGIN_RATE_LIMIT', 10),
      windowMs: intEnv('LOGIN_RATE_WINDOW_MS', 60_000),
    },
    presignRateLimit: {
      limit: intEnv('PRESIGN_RATE_LIMIT', 30),
      windowMs: intEnv('PRESIGN_RATE_WINDOW_MS', 60_000),
    },
    connectRateLimit: {
      limit: intEnv('CONNECT_RATE_LIMIT', 30),
      windowMs: intEnv('CONNECT_RATE_WINDOW_MS', 60_000),
    },
    replicaId: env('SERVER_REPLICA_ID', randomUUID()),
    ...(corsOrigin ? { corsOrigin } : {}),
    gcIntervalMs: intEnv('GC_INTERVAL_MS', 60_000),
    gcRetentionMs: intEnv('GC_RETENTION_MS', 7 * 24 * 60 * 60 * 1000),
    replicaStaleTtlMs: intEnv('REPLICA_STALE_TTL_MS', 14 * 24 * 60 * 60 * 1000),
    replicaNeverAckedCap: intEnv('REPLICA_NEVER_ACKED_CAP', 64),
    compactionIntervalMs: intEnv('COMPACTION_INTERVAL_MS', 60_000),
    ...(s3Endpoint
      ? {
          s3Endpoint,
          s3Region: process.env.S3_REGION ?? 'us-east-1',
          s3Bucket: process.env.S3_BUCKET ?? 'open-outliner',
          s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
          s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
        }
      : {}),
  };
}

/** Read a file as UTF-8 (thin wrapper for testability). */
export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}
