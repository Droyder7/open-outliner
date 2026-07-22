import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../src/db/db.js';
import { migrate, listMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import {
  createUser,
  createWorkspace,
  addMember,
  removeMember,
  canAccessDocument,
  createDocument,
  listDocuments,
} from '../src/db/tenancy-repo.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForUser,
} from '../src/db/sessions-repo.js';
import { rankBetween } from '@open-outliner/shared';

// These tests require a live Postgres (DATABASE_URL). They are skipped when it is
// unset so the suite stays green in environments without a database.
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('migrations + tenancy + sessions (integration)', () => {
  let db: Db;
  const config = loadConfig();

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('applies all migrations and is idempotent on re-run', async () => {
    const all = listMigrations(config.migrationsDir);
    // Versions are contiguous starting at 1 (forward-only, no gaps).
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1));
    expect(all.length).toBeGreaterThanOrEqual(4);
    // Re-running applies nothing new.
    const second = await migrate(db, config.migrationsDir);
    expect(second.applied).toEqual([]);
  });

  it('seats a workspace owner and enforces one owner', async () => {
    const email = `owner-${Date.now()}@example.test`;
    const ownerId = await createUser(db, email, 'Owner', 'hash');
    const workspaceId = await createWorkspace(db, ownerId, 'My Workspace');

    const res = await db.query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,
      [workspaceId, ownerId],
    );
    expect(res.rows[0]?.role).toBe('owner');

    // A second 'owner' row violates the partial unique index.
    await expect(
      db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [workspaceId, await createUser(db, `x-${Date.now()}@e.test`, null, null)],
      ),
    ).rejects.toThrow();
  });

  it('members get equal document access; removal kills access and sessions', async () => {
    const ownerId = await createUser(db, `o2-${Date.now()}@e.test`, null, 'h');
    const memberId = await createUser(db, `m2-${Date.now()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'WS');
    await addMember(db, workspaceId, memberId);

    const rootId = randomUUID();
    const documentId = await createDocument(
      db,
      workspaceId,
      'Doc',
      rootId,
      rankBetween(null, null),
    );

    expect(await canAccessDocument(db, documentId, memberId)).toBe(true);
    expect((await listDocuments(db, workspaceId)).map((d) => d.title)).toContain('Doc');

    // Give the member a live session, then remove them.
    const sessionId = await createSession(db, memberId, config.sessionTtlMs);
    expect(await resolveSession(db, sessionId)).toEqual({ userId: memberId });

    const removal = await removeMember(db, workspaceId, memberId);
    expect(removal.removed).toBe(true);
    expect(removal.revokedSessionIds).toContain(sessionId);

    // Access and the session are both gone (ADR-0014 kill switch).
    expect(await canAccessDocument(db, documentId, memberId)).toBe(false);
    expect(await resolveSession(db, sessionId)).toBeNull();
  });

  it('the owner cannot be removed by removeMember', async () => {
    const ownerId = await createUser(db, `o3-${Date.now()}@e.test`, null, 'h');
    const workspaceId = await createWorkspace(db, ownerId, 'WS');
    const res = await removeMember(db, workspaceId, ownerId);
    expect(res.removed).toBe(false);
  });

  it('session resolve honors revoke and a full user kill', async () => {
    const userId = await createUser(db, `s-${Date.now()}@e.test`, null, 'h');
    const s1 = await createSession(db, userId, config.sessionTtlMs);
    const s2 = await createSession(db, userId, config.sessionTtlMs);

    await revokeSession(db, s1);
    expect(await resolveSession(db, s1)).toBeNull();
    expect(await resolveSession(db, s2)).toEqual({ userId });

    const killed = await revokeAllSessionsForUser(db, userId);
    expect(killed).toContain(s2);
    expect(await resolveSession(db, s2)).toBeNull();
  });

  it('an expired session does not resolve', async () => {
    const userId = await createUser(db, `e-${Date.now()}@e.test`, null, 'h');
    const sessionId = await createSession(db, userId, -1000); // already expired
    expect(await resolveSession(db, sessionId)).toBeNull();
  });
});
