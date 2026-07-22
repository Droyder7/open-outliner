import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/http/server.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

/**
 * Exercises the real HTTP transport (cookies, CSRF, CORS-free same-origin
 * calls) end to end, on top of the `dispatch()` coverage in
 * rpc.integration.test.ts which stays at the pure-function level.
 */
describeDb('HTTP /rpc transport (API, Phase 6 + CSRF, Phase 5)', () => {
  let db: Db;
  const config = loadConfig();
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await migrate(db, config.migrationsDir);
    const { server } = createHttpServer({ db, config });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await close?.();
    if (db) await db.close();
  });

  function extractCookie(res: Response, name: string): string | undefined {
    // Node's fetch exposes multiple Set-Cookie values via getSetCookie().
    const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const raw of all) {
      const [pair] = raw.split(';');
      const [key, value] = pair!.split('=');
      if (key === name) return value;
    }
    return undefined;
  }

  async function rpc(body: unknown, cookieHeader?: string, csrfToken?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(`${baseUrl}/rpc`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json();
    return { res, json };
  }

  it('Login sets an httpOnly session cookie and a readable CSRF cookie', async () => {
    const email = `http-${crypto.randomUUID()}@e.test`;
    await rpc({ method: 'Signup', params: { email, password: 'hunter2hunter2' }, requestId: crypto.randomUUID() });
    const { res, json } = await rpc({
      method: 'Login',
      params: { email, password: 'hunter2hunter2' },
      requestId: crypto.randomUUID(),
    });
    expect(json.ok).toBe(true);
    const sessionCookie = extractCookie(res, config.sessionCookieName);
    const csrfCookie = extractCookie(res, config.csrfCookieName);
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBe(json.result.csrfToken);
  });

  it('rejects a mutating call missing the CSRF header, accepts it with a matching one', async () => {
    const email = `csrf-${crypto.randomUUID()}@e.test`;
    const signup = await rpc({
      method: 'Signup',
      params: { email, password: 'hunter2hunter2' },
      requestId: crypto.randomUUID(),
    });
    const sessionCookie = extractCookie(signup.res, config.sessionCookieName)!;
    const csrfToken = extractCookie(signup.res, config.csrfCookieName)!;
    // A real browser sends every cookie for the origin automatically,
    // regardless of whether the request also carries an X-CSRF-Token header —
    // the double-submit check compares the cookie against that header.
    const cookieHeader = `${config.sessionCookieName}=${sessionCookie}; ${config.csrfCookieName}=${csrfToken}`;

    const who = await rpc({ method: 'WhoAmI', params: {}, requestId: crypto.randomUUID() }, cookieHeader);
    const workspaceId = who.json.result.workspaceIds[0];

    const readWithoutCsrf = await rpc(
      { method: 'ListDocuments', params: { workspaceId }, requestId: crypto.randomUUID() },
      cookieHeader,
    );
    // ListDocuments is a read method (CSRF-exempt) — use CreateDocument, a mutation, instead.
    const mutateWithoutCsrf = await rpc(
      { method: 'CreateDocument', params: { workspaceId, title: 'No CSRF' }, requestId: crypto.randomUUID() },
      cookieHeader,
    );
    expect(mutateWithoutCsrf.res.status).toBe(403);
    expect(mutateWithoutCsrf.json.ok).toBe(false);
    expect(mutateWithoutCsrf.json.error.code).toBe('forbidden');

    const mutateWithCsrf = await rpc(
      { method: 'CreateDocument', params: { workspaceId, title: 'With CSRF' }, requestId: crypto.randomUUID() },
      cookieHeader,
      csrfToken,
    );
    expect(mutateWithCsrf.json.ok).toBe(true);
    expect(readWithoutCsrf.json.ok).toBe(true); // sanity: reads don't need the token at all
  });

  it('rate-limits repeated Login attempts', async () => {
    const email = `ratelimit-${crypto.randomUUID()}@e.test`;
    await rpc({ method: 'Signup', params: { email, password: 'hunter2hunter2' }, requestId: crypto.randomUUID() });
    const attempts = await Promise.all(
      Array.from({ length: config.loginRateLimit.limit + 5 }, () =>
        rpc({ method: 'Login', params: { email, password: 'wrong' }, requestId: crypto.randomUUID() }),
      ),
    );
    expect(attempts.some((a) => a.json.error?.code === 'rate_limited')).toBe(true);
  });
});
