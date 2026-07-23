import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  /** Port the Hocuspocus collaboration (WS) server listens on. */
  wsPort: number;
  /** Directory holding the numbered .sql migrations (repo /migrations). */
  migrationsDir: string;
  sessionCookieName: string;
  csrfCookieName: string;
  sessionTtlMs: number;
  /** Projection catch-up sweep interval (ADR-0013). */
  projectionSweepMs: number;
  /** How often a live Hocuspocus connection re-resolves its session (ADR-0014). */
  authHeartbeatMs: number;
  /** Default subtree depth for GetItems / GetChildren (load-on-expand). */
  defaultDocDepth: number;
  defaultChildrenDepth: number;
  loginRateLimit: { limit: number; windowMs: number };
  presignRateLimit: { limit: number; windowMs: number };
  connectRateLimit: { limit: number; windowMs: number };
  /** This server process's Yjs replica id — the HLC tie-breaker stamped on cycle-repair writes (ADR-0009/0012). */
  replicaId: string;
  /**
   * Dev-only cross-origin allowance (e.g. the Vite dev server origin) so the
   * client can call `/rpc` with credentials from a different port. Unset in
   * self-host, where the app is served same-origin (OPS, Phase 12).
   */
  corsOrigin?: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
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
  return {
    databaseUrl: env('DATABASE_URL', 'postgres://outliner:outliner@localhost:5432/outliner'),
    port: intEnv('PORT', 8787),
    wsPort: intEnv('WS_PORT', 8788),
    migrationsDir: env('MIGRATIONS_DIR', defaultMigrationsDir()),
    sessionCookieName: env('SESSION_COOKIE_NAME', 'oo_session'),
    csrfCookieName: env('CSRF_COOKIE_NAME', 'oo_csrf'),
    sessionTtlMs: intEnv('SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 30), // 30 days
    projectionSweepMs: intEnv('PROJECTION_SWEEP_MS', 10_000),
    authHeartbeatMs: intEnv('AUTH_HEARTBEAT_MS', 60_000),
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
  };
}

/** Read a file as UTF-8 (thin wrapper for testability). */
export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}
