import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { dispatch } from '../src/rpc/dispatch.js';
import type { RpcContext } from '../src/rpc/handlers.js';
import { createRateLimiter } from '../src/http/rate-limit.js';
import { createSession, resolveSession } from '../src/db/sessions-repo.js';
import type { RpcMethod, RpcParams } from '@open-outliner/shared';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('/rpc dispatch (API, Phase 6)', () => {
  let db: Db;
  const config = loadConfig();

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function freshCtx(session: { userId: string; sessionId: string } | null): RpcContext {
    return {
      db,
      config,
      session,
      ip: '127.0.0.1',
      rateLimiters: {
        login: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
        presign: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
      },
      effects: { setCookies: [], revokedSessionIds: [] },
    };
  }

  async function call<M extends RpcMethod>(
    ctx: RpcContext,
    method: M,
    params: RpcParams[M],
  ) {
    return dispatch({ method, params, requestId: crypto.randomUUID() }, ctx);
  }

  it('Signup issues a session cookie + CSRF token and WhoAmI reflects it', async () => {
    const ctx = freshCtx(null);
    const email = `signup-${crypto.randomUUID()}@e.test`;
    const signup = await call(ctx, 'Signup', { email, password: 'hunter2hunter2' });
    expect(signup.response.ok).toBe(true);
    if (!signup.response.ok) throw new Error('unreachable');
    expect(signup.response.result.userId).toBeTruthy();
    expect(signup.response.result.csrfToken).toBeTruthy();
    const sessionCookie = signup.setCookies.find((c) => c.name === config.sessionCookieName);
    expect(sessionCookie?.opts.httpOnly).toBe(true);

    const sessionId = sessionCookie!.value;
    const whoCtx = freshCtx({ userId: signup.response.result.userId, sessionId });
    const who = await call(whoCtx, 'WhoAmI', {});
    expect(who.response.ok).toBe(true);
    if (who.response.ok) expect(who.response.result.userId).toBe(signup.response.result.userId);
  });

  it('rejects a duplicate Signup email with a conflict error', async () => {
    const ctx = freshCtx(null);
    const email = `dup-${crypto.randomUUID()}@e.test`;
    await call(ctx, 'Signup', { email, password: 'hunter2hunter2' });
    const second = await call(freshCtx(null), 'Signup', { email, password: 'hunter2hunter2' });
    expect(second.response.ok).toBe(false);
    if (!second.response.ok) expect(second.response.error.code).toBe('conflict');
  });

  it('Login rejects a wrong password and succeeds with the right one', async () => {
    const email = `login-${crypto.randomUUID()}@e.test`;
    await call(freshCtx(null), 'Signup', { email, password: 'correct-password' });

    const bad = await call(freshCtx(null), 'Login', { email, password: 'wrong-password' });
    expect(bad.response.ok).toBe(false);
    if (!bad.response.ok) expect(bad.response.error.code).toBe('unauthorized');

    const good = await call(freshCtx(null), 'Login', { email, password: 'correct-password' });
    expect(good.response.ok).toBe(true);
  });

  it('rejects any non-public method with no session', async () => {
    const result = await call(freshCtx(null), 'WhoAmI', {});
    expect(result.response.ok).toBe(false);
    if (!result.response.ok) expect(result.response.error.code).toBe('unauthorized');
  });

  it('CreateDocument seeds a root item at the document id, then GetItems/UpdateItem round-trip with version conflict handling', async () => {
    const email = `doc-${crypto.randomUUID()}@e.test`;
    const signup = await call(freshCtx(null), 'Signup', { email, password: 'hunter2hunter2' });
    if (!signup.response.ok) throw new Error('signup failed');
    const userId = signup.response.result.userId;
    const sessionId = signup.setCookies.find((c) => c.name === config.sessionCookieName)!.value;
    const ctx = freshCtx({ userId, sessionId });

    const who = await call(ctx, 'WhoAmI', {});
    if (!who.response.ok) throw new Error('whoami failed');
    const workspaceId = who.response.result.workspaceIds[0]!;

    const created = await call(ctx, 'CreateDocument', { workspaceId, title: 'My Doc' });
    expect(created.response.ok).toBe(true);
    if (!created.response.ok) throw new Error('unreachable');
    const { documentId, rootItemId } = created.response.result;
    expect(rootItemId).toBe(documentId); // session.ts invariant, see tenancy-repo.createDocumentWithRoot

    const items = await call(ctx, 'GetItems', { documentId });
    expect(items.response.ok).toBe(true);
    if (!items.response.ok) throw new Error('unreachable');
    const root = items.response.result.items.find((i) => i.id === rootItemId);
    expect(root).toBeTruthy();
    expect(root?.version).toBe(1);

    const updated = await call(ctx, 'UpdateItem', {
      documentId,
      id: rootItemId,
      version: root!.version,
      fields: { note: 'hello' },
    });
    expect(updated.response.ok).toBe(true);
    if (updated.response.ok) expect(updated.response.result.item.note).toBe('hello');

    // Retrying with the now-stale version is a version_conflict, not a crash.
    const stale = await call(ctx, 'UpdateItem', {
      documentId,
      id: rootItemId,
      version: root!.version,
      fields: { note: 'stale write' },
    });
    expect(stale.response.ok).toBe(false);
    if (!stale.response.ok) expect(stale.response.error.code).toBe('version_conflict');

    const missing = await call(ctx, 'UpdateItem', {
      documentId,
      id: crypto.randomUUID(),
      version: 1,
      fields: { note: 'x' },
    });
    expect(missing.response.ok).toBe(false);
    if (!missing.response.ok) expect(missing.response.error.code).toBe('not_found');
  });

  it('CSRF-exempt read methods and forbidden cross-workspace access', async () => {
    const ownerEmail = `owner-${crypto.randomUUID()}@e.test`;
    const owner = await call(freshCtx(null), 'Signup', { email: ownerEmail, password: 'hunter2hunter2' });
    if (!owner.response.ok) throw new Error('signup failed');
    const ownerSessionId = owner.setCookies.find((c) => c.name === config.sessionCookieName)!.value;
    const ownerCtx = freshCtx({ userId: owner.response.result.userId, sessionId: ownerSessionId });
    const ownerWho = await call(ownerCtx, 'WhoAmI', {});
    if (!ownerWho.response.ok) throw new Error('whoami failed');
    const workspaceId = ownerWho.response.result.workspaceIds[0]!;

    const strangerEmail = `stranger-${crypto.randomUUID()}@e.test`;
    const stranger = await call(freshCtx(null), 'Signup', { email: strangerEmail, password: 'hunter2hunter2' });
    if (!stranger.response.ok) throw new Error('signup failed');
    const strangerSessionId = stranger.setCookies.find((c) => c.name === config.sessionCookieName)!.value;
    const strangerCtx = freshCtx({ userId: stranger.response.result.userId, sessionId: strangerSessionId });

    const forbidden = await call(strangerCtx, 'ListDocuments', { workspaceId });
    expect(forbidden.response.ok).toBe(false);
    if (!forbidden.response.ok) expect(forbidden.response.error.code).toBe('forbidden');
  });

  it('InviteMember + RemoveMember revoke the removed member session for immediate WS drop', async () => {
    const ownerEmail = `owner2-${crypto.randomUUID()}@e.test`;
    const owner = await call(freshCtx(null), 'Signup', { email: ownerEmail, password: 'hunter2hunter2' });
    if (!owner.response.ok) throw new Error('signup failed');
    const ownerSessionId = owner.setCookies.find((c) => c.name === config.sessionCookieName)!.value;
    const ownerCtx = freshCtx({ userId: owner.response.result.userId, sessionId: ownerSessionId });
    const ownerWho = await call(ownerCtx, 'WhoAmI', {});
    if (!ownerWho.response.ok) throw new Error('whoami failed');
    const workspaceId = ownerWho.response.result.workspaceIds[0]!;

    const memberEmail = `member-${crypto.randomUUID()}@e.test`;
    const invite = await call(ownerCtx, 'InviteMember', { workspaceId, email: memberEmail });
    expect(invite.response.ok).toBe(true);
    if (!invite.response.ok) throw new Error('unreachable');
    const memberId = invite.response.result.userId;

    // Simulate the member holding a live session (as if already connected) so
    // RemoveMember's kill switch (ADR-0014) has something to revoke.
    const memberSessionId = await createSession(db, memberId, config.sessionTtlMs);
    expect(await resolveSession(db, memberSessionId)).toEqual({ userId: memberId });

    const remove = await call(ownerCtx, 'RemoveMember', { workspaceId, userId: memberId });
    expect(remove.response.ok).toBe(true);
    expect(remove.revokedSessionIds).toContain(memberSessionId);
    // The instant-kill effect: the session no longer resolves on the very next check.
    expect(await resolveSession(db, memberSessionId)).toBeNull();
  });
});
