import { loadConfig } from '../config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

/**
 * CLI: apply pending migrations to the configured database.
 *   pnpm --filter @open-outliner/server migrate
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    console.log(`Applying migrations from ${config.migrationsDir} …`);
    const result = await migrate(db, config.migrationsDir);
    if (result.applied.length === 0) {
      console.log('No pending migrations. Database is up to date.');
    } else {
      for (const m of result.applied) console.log(`  applied ${m.name}`);
      console.log(`Done — ${result.applied.length} migration(s) applied.`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
