import {
  isRpcMethod,
  rpcErr,
  RPC_PUBLIC_METHODS,
  RPC_READ_METHODS,
  type RpcMethod,
  type RpcResponse,
  type RpcResult,
} from '@open-outliner/shared';
import { handlers, type RpcContext } from './handlers.js';
import { RpcHandlerError } from './errors.js';
import type { CookieOptions } from '../http/cookies.js';

export interface DispatchResult {
  response: RpcResponse;
  setCookies: { name: string; value: string; opts: CookieOptions }[];
  revokedSessionIds: string[];
}

/**
 * Validate + dispatch one already-parsed `/rpc` body against `ctx`. This is
 * the single place a wire-level request becomes a typed `RpcResponse` — the
 * HTTP transport (`http/server.ts`) owns parsing the request and applying
 * `setCookies`/`revokedSessionIds`, so this function has no knowledge of
 * `http.IncomingMessage`/`ServerResponse` and is directly unit-testable.
 */
export async function dispatch(body: unknown, ctx: RpcContext): Promise<DispatchResult> {
  const effects = ctx.effects;

  if (typeof body !== 'object' || body === null) {
    return {
      response: rpcErr('bad_request', 'Request body must be a JSON object'),
      setCookies: [],
      revokedSessionIds: [],
    };
  }
  const { method, params, requestId } = body as Record<string, unknown>;
  if (!isRpcMethod(method)) {
    return {
      response: rpcErr('bad_request', `Unknown method: ${String(method)}`),
      setCookies: [],
      revokedSessionIds: [],
    };
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return {
      response: rpcErr('bad_request', 'Missing requestId'),
      setCookies: [],
      revokedSessionIds: [],
    };
  }
  if (!RPC_PUBLIC_METHODS.includes(method) && !ctx.session) {
    return {
      response: rpcErr('unauthorized', 'Authentication required'),
      setCookies: [],
      revokedSessionIds: [],
    };
  }

  try {
    const handler = handlers[method] as (p: unknown, c: RpcContext) => Promise<unknown>;
    const result = await handler(params, ctx);
    // The dispatch boundary is inherently type-erased: `handlers` is indexed by
    // a runtime-checked `method` string, so the compiler can't narrow `result`
    // to the one variant `RpcResult[typeof method]` the way a direct call to
    // e.g. `handlers.WhoAmI(...)` would. Each handler's own signature (in
    // handlers.ts) is fully typed, so this cast doesn't hide a real mismatch.
    const response: RpcResponse = { ok: true, result: result as RpcResult[RpcMethod] };
    return {
      response,
      setCookies: effects.setCookies,
      revokedSessionIds: effects.revokedSessionIds,
    };
  } catch (err) {
    if (err instanceof RpcHandlerError) {
      return {
        response: rpcErr(err.code, err.message, err.details),
        setCookies: effects.setCookies,
        revokedSessionIds: effects.revokedSessionIds,
      };
    }
    return {
      response: rpcErr('internal', 'Internal server error'),
      setCookies: effects.setCookies,
      revokedSessionIds: effects.revokedSessionIds,
    };
  }
}

/** Whether `method` is safe to fail fast offline rather than queue (OFF). */
export function isReadMethod(method: string): boolean {
  return (RPC_READ_METHODS as readonly string[]).includes(method);
}
