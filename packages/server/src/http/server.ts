import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from '../db/db.js';
import type { ServerConfig } from '../config.js';
import { resolveSession } from '../db/sessions-repo.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { verifyCsrfToken } from './csrf.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { dispatch, isReadMethod } from '../rpc/dispatch.js';
import type { RpcContext } from '../rpc/handlers.js';
import { RPC_PUBLIC_METHODS } from '@open-outliner/shared';

const MAX_BODY_BYTES = 1_000_000; // 1MB — generous for a command/args payload, not a blob upload

export interface HttpServerDeps {
  db: Db;
  config: ServerConfig;
  log?: (msg: string) => void;
  /** Called with every session id revoked by this request (RemoveMember/Logout) so the caller can drop live Hocuspocus sockets (ADR-0014). */
  onSessionsRevoked?: (sessionIds: string[]) => void;
}

export interface AppHttpServer {
  server: Server;
  loginLimiter: RateLimiter;
  presignLimiter: RateLimiter;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigin: string | undefined,
): void {
  const origin = req.headers.origin;
  if (corsOrigin && origin === corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

export function createHttpServer(deps: HttpServerDeps): AppHttpServer {
  const { db, config } = deps;
  const log = deps.log ?? (() => {});
  const loginLimiter = createRateLimiter(config.loginRateLimit);
  const presignLimiter = createRateLimiter(config.presignRateLimit);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`unhandled /rpc error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'internal', message: 'Internal server error' },
        }),
      );
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res, config.corsOrigin);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'Not found' } }));
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[config.sessionCookieName];
    const resolved = sessionId ? await resolveSession(db, sessionId) : null;
    const session = resolved ? { userId: resolved.userId, sessionId: sessionId! } : null;

    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'bad_request', message: 'Request body too large' },
        }),
      );
      return;
    }

    let body: unknown;
    try {
      body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'Malformed JSON' } }),
      );
      return;
    }

    const method =
      typeof body === 'object' && body !== null ? (body as { method?: unknown }).method : undefined;

    // CSRF: required for any authenticated, state-changing call. Public
    // (Signup/Login) and read-only methods are exempt — see rpc.ts.
    if (
      session &&
      typeof method === 'string' &&
      !RPC_PUBLIC_METHODS.includes(method as (typeof RPC_PUBLIC_METHODS)[number]) &&
      !isReadMethod(method)
    ) {
      const headerToken = req.headers['x-csrf-token'];
      const cookieToken = cookies[config.csrfCookieName];
      if (
        !verifyCsrfToken(cookieToken, typeof headerToken === 'string' ? headerToken : undefined)
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'forbidden', message: 'CSRF token missing or invalid' },
          }),
        );
        return;
      }
    }

    const userAgentHeader = req.headers['user-agent'];
    const ctx: RpcContext = {
      db,
      config,
      session,
      ip: clientIp(req),
      ...(typeof userAgentHeader === 'string' ? { userAgent: userAgentHeader } : {}),
      rateLimiters: { login: loginLimiter, presign: presignLimiter },
      effects: { setCookies: [], revokedSessionIds: [] },
    };

    const result = await dispatch(body, ctx);

    for (const cookie of result.setCookies) {
      res.appendHeader('Set-Cookie', serializeCookie(cookie.name, cookie.value, cookie.opts));
    }
    if (result.revokedSessionIds.length > 0) {
      deps.onSessionsRevoked?.(result.revokedSessionIds);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.response));
  }

  return { server, loginLimiter, presignLimiter };
}
