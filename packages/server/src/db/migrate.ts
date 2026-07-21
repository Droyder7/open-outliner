import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';
import { readTextFile } from '../config.js';

export interface MigrationFile {
  /** Numeric prefix, e.g. 1, 2, 3 — the apply order. */
  readonly version: number;
  readonly name: string; // full filename
  readonly path: string;
}

const MIGRATION_RE = /^(\d+)_.*\.sql$/;

/** List `NNNN_*.sql` migrations in a directory, sorted by numeric version. */
export function listMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir);
  const migrations: MigrationFile[] = [];
  for (const name of files) {
    const m = MIGRATION_RE.exec(name);
    if (!m) continue;
    migrations.push({ version: Number.parseInt(m[1]!, 10), name, path: join(dir, name) });
  }
  migrations.sort((a, b) => a.version - b.version);

  // Guard against duplicate version numbers — an ambiguous ordering is a bug.
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version) {
      throw new Error(
        `Duplicate migration version ${migrations[i]!.version}: ${migrations[i - 1]!.name} and ${migrations[i]!.name}`,
      );
    }
  }
  return migrations;
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(db: Db): Promise<Set<number>> {
  const res = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  return new Set(res.rows.map((r) => r.version));
}

export interface MigrateResult {
  applied: MigrationFile[];
  alreadyApplied: number[];
}

/**
 * Apply all pending migrations in numeric order. Each migration file wraps its
 * own `BEGIN … COMMIT`; the runner records the version in `schema_migrations`
 * inside the SAME transaction by appending the bookkeeping INSERT before the
 * file's trailing COMMIT is reached — instead, since files self-manage their
 * transaction, we record the version in a follow-up statement guarded by the
 * file having applied cleanly. If the file fails, it rolls itself back and we
 * never record it, so re-running retries it.
 *
 * Forward-only: a version present on disk with a lower number than an
 * already-applied one but itself unapplied is an error (a back-dated migration).
 */
export async function migrate(db: Db, dir: string): Promise<MigrateResult> {
  await ensureMigrationsTable(db);
  const all = listMigrations(dir);
  const applied = await appliedVersions(db);

  const pending = all.filter((m) => !applied.has(m.version));
  const maxApplied = all
    .filter((m) => applied.has(m.version))
    .reduce((max, m) => Math.max(max, m.version), 0);

  for (const m of pending) {
    if (m.version < maxApplied) {
      throw new Error(
        `Refusing to apply back-dated migration ${m.name} (version ${m.version} < applied ${maxApplied}). Migrations are forward-only.`,
      );
    }
  }

  const result: MigrateResult = { applied: [], alreadyApplied: [...applied].sort((a, b) => a - b) };

  for (const m of pending) {
    const sql = readTextFile(m.path);
    // The file self-manages BEGIN/COMMIT. Run it, then record the version. If the
    // file threw, it rolled back and the version stays unrecorded (safe retry).
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
      m.version,
      m.name,
    ]);
    result.applied.push(m);
  }

  return result;
}
