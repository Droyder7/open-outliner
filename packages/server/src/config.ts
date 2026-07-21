import { readFileSync } from 'node:fs';

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  /** Directory holding the numbered .sql migrations (repo /migrations). */
  migrationsDir: string;
  sessionCookieName: string;
  sessionTtlMs: number;
  /** Projection catch-up sweep interval (ADR-0013). */
  projectionSweepMs: number;
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
  return {
    databaseUrl: env(
      'DATABASE_URL',
      'postgres://outliner:outliner@localhost:5432/outliner',
    ),
    port: intEnv('PORT', 8787),
    migrationsDir: env('MIGRATIONS_DIR', defaultMigrationsDir()),
    sessionCookieName: env('SESSION_COOKIE_NAME', 'oo_session'),
    sessionTtlMs: intEnv('SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 30), // 30 days
    projectionSweepMs: intEnv('PROJECTION_SWEEP_MS', 10_000),
  };
}

/** Read a file as UTF-8 (thin wrapper for testability). */
export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}
