import type { RpcErrorCode, RpcMethod, RpcParams, RpcResult } from '@open-outliner/shared';
import { RPC_PUBLIC_METHODS as PUBLIC_METHODS, RPC_READ_METHODS } from '@open-outliner/shared';

/**
 * Typed `/rpc` client (api-and-write-path.md). One `POST /rpc` call per
 * command, cookie session carried automatically by the browser
 * (`credentials: 'include'`), CSRF double-submit header attached for any
 * mutating, authenticated call (ADR-0014) — reads and the public
 * (Signup/Login) methods are exempt, matching the server's own exemption
 * list so the two sides can't drift.
 */

export class RpcClientError extends Error {
  readonly code: RpcErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RpcClientError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const CSRF_COOKIE_NAME = 'oo_csrf'; // must match ServerConfig.csrfCookieName default

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export interface RpcClientOptions {
  /** Base URL of the `/rpc` endpoint, e.g. `http://localhost:8787`. Defaults to same-origin. */
  baseUrl?: string;
}

export function createRpcClient(opts: RpcClientOptions = {}) {
  const base = opts.baseUrl ?? '';

  async function call<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<RpcResult[M]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const needsCsrf =
      !(PUBLIC_METHODS as readonly RpcMethod[]).includes(method) &&
      !(RPC_READ_METHODS as readonly RpcMethod[]).includes(method);
    if (needsCsrf) {
      const csrfToken = readCookie(CSRF_COOKIE_NAME);
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }

    let res: Response;
    try {
      res = await fetch(`${base}/rpc`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ method, params, requestId: crypto.randomUUID() }),
      });
    } catch (err) {
      throw new RpcClientError('internal', err instanceof Error ? err.message : 'Network error');
    }

    const body = (await res.json()) as { ok: true; result: RpcResult[M] } | { ok: false; error: { code: RpcErrorCode; message: string; details?: Record<string, unknown> } };
    if (!body.ok) throw new RpcClientError(body.error.code, body.error.message, body.error.details);
    return body.result;
  }

  return { call };
}

export type RpcClient = ReturnType<typeof createRpcClient>;

/** Whether `method` is safe to fail fast offline rather than queue (OFF, offline-and-pwa.md). */
export function isReadMethod(method: RpcMethod): boolean {
  return (RPC_READ_METHODS as readonly RpcMethod[]).includes(method);
}

export function isPublicMethod(method: RpcMethod): boolean {
  return (PUBLIC_METHODS as readonly RpcMethod[]).includes(method);
}

export type { RpcMethod, RpcParams, RpcResult };
