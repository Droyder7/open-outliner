import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_VERSION } from '@open-outliner/shared';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { dispatch } from '../src/rpc/dispatch.js';
import { createRateLimiter } from '../src/http/rate-limit.js';
import type { RpcContext } from '../src/rpc/handlers.js';
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('committed document receipts', () => {
  let db: Db;
  const config = loadConfig();
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await migrate(db, config.migrationsDir);
  });
  afterAll(async () => {
    await db?.close();
  });
  function context(session: RpcContext['session'] = null): RpcContext {
    return {
      db,
      config,
      session,
      ip: '127.0.0.1',
      rateLimiters: {
        login: createRateLimiter({ limit: 1000, windowMs: 60000 }),
        presign: createRateLimiter({ limit: 1000, windowMs: 60000 }),
      },
      effects: { setCookies: [], revokedSessionIds: [] },
    };
  }
  it('registers offline IDs idempotently and receipts acknowledge exactly one committed payload', async () => {
    const ctx = context();
    const signup = await dispatch(
      {
        method: 'Signup',
        requestId: crypto.randomUUID(),
        params: { email: `${crypto.randomUUID()}@receipt.test`, password: 'hunter2hunter2' },
      },
      ctx,
    );
    if (!signup.response.ok) throw new Error('signup failed');
    ctx.session = {
      userId: signup.response.result.userId,
      sessionId: ctx.effects.setCookies.find((c) => c.name === config.sessionCookieName)!.value,
    };
    const who = await dispatch({ method: 'WhoAmI', params: {}, requestId: 'who' }, ctx);
    if (!who.response.ok) throw new Error('who failed');
    const documentId = crypto.randomUUID();
    const params = {
      documentId,
      workspaceId: who.response.result.workspaceIds[0],
      title: 'Offline document',
    };
    for (let i = 0; i < 2; i++) {
      expect(
        (await dispatch({ method: 'CreateDocument', params, requestId: crypto.randomUUID() }, ctx))
          .response.ok,
      ).toBe(true);
    }
    const doc = new Y.Doc();
    doc.getMap('test').set('value', 'durable');
    const payload = {
      documentId,
      batchId: crypto.randomUUID(),
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    };
    const first = await dispatch(
      { method: 'PersistDocumentUpdate', params: payload, requestId: 'first' },
      ctx,
    );
    const retry = await dispatch(
      { method: 'PersistDocumentUpdate', params: payload, requestId: 'retry' },
      ctx,
    );
    expect(first.response.ok).toBe(true);
    expect(retry.response).toEqual(first.response);
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM document_update_receipts WHERE document_id=$1',
          [documentId],
        )
      ).rows[0]!.n,
    ).toBe(1);
    doc.getMap('test').set('value', 'different');
    const reused = await dispatch(
      {
        method: 'PersistDocumentUpdate',
        requestId: 'reused',
        params: { ...payload, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') },
      },
      ctx,
    );
    expect(reused.response.ok).toBe(false);
    if (!reused.response.ok) expect(reused.response.error.code).toBe('conflict');
    const wrongVersion = await dispatch(
      {
        method: 'PersistDocumentUpdate',
        requestId: 'wrong-version',
        params: { ...payload, schemaVersion: 0 },
      },
      ctx,
    );
    expect(wrongVersion.response.ok).toBe(false);
    const unauth = await dispatch(
      {
        method: 'GetDocumentState',
        requestId: 'unauth',
        params: { documentId, schemaVersion: DOCUMENT_SCHEMA_VERSION },
      },
      context(),
    );
    expect(unauth.response.ok).toBe(false);
    const read = await dispatch(
      {
        method: 'GetDocumentState',
        requestId: 'read',
        params: { documentId, schemaVersion: DOCUMENT_SCHEMA_VERSION },
      },
      ctx,
    );
    expect(read.response.ok).toBe(true);
    if (read.response.ok) {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Buffer.from(read.response.result.update, 'base64'));
      expect(copy.getMap('test').get('value')).toBe('durable');
      copy.destroy();
    }
    doc.destroy();
  });
});
