import {
  RPC_QUEUEABLE_METHODS,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
} from '@open-outliner/shared';
import { createRpcClient, RpcClientError, RpcNetworkError } from '../rpc.js';
import { offlineDb } from './db.js';
import { isQuotaError, setStorageStatus } from './storage-status.js';

/**
 * The durable mutation outbox (offline-and-pwa.md): queueable API-plane
 * mutations (`RPC_QUEUEABLE_METHODS` — naturally idempotent under blind
 * retry) made while offline are persisted locally and replayed on
 * reconnect, each keyed by its own client-generated `requestId`. Reads and
 * non-idempotent mutations (e.g. `CreateDocument`) are never queued — they
 * fail fast offline instead (`rpc.ts`/`RPC_QUEUEABLE_METHODS`).
 */

const rpc = createRpcClient();

export function isQueueable(method: RpcMethod): boolean {
  return (RPC_QUEUEABLE_METHODS as readonly RpcMethod[]).includes(method);
}

function isLikelyNetworkFailure(err: unknown): boolean {
  // A real server response (even an error one) means the network is fine —
  // only a client-side fetch throw (RpcNetworkError) or the browser's own
  // offline signal count as "network is down", so a genuine server-side
  // rejection is never queued.
  return !navigator.onLine || err instanceof RpcNetworkError;
}

export type CallOrQueueResult<M extends RpcMethod> =
  { queued: false; result: RpcResult[M] } | { queued: true };

/**
 * Call `method` normally; if it's queueable and the network looks down,
 * enqueue it instead of failing the caller. Call sites treat `{queued:
 * true}` as an optimistic local success (the UI already applied the local
 * state change; this is only about the durable write reaching the server).
 */
export async function callOrQueue<M extends RpcMethod>(
  method: M,
  params: RpcParams[M],
): Promise<CallOrQueueResult<M>> {
  if (isQueueable(method) && !navigator.onLine) {
    await enqueue(method, params);
    return { queued: true };
  }
  try {
    const result = await rpc.call(method, params);
    return { queued: false, result } as CallOrQueueResult<M>;
  } catch (err) {
    if (isQueueable(method) && isLikelyNetworkFailure(err)) {
      await enqueue(method, params);
      return { queued: true };
    }
    throw err;
  }
}

async function enqueue(method: RpcMethod, params: unknown): Promise<void> {
  const entry = { requestId: crypto.randomUUID(), method, params, createdAt: Date.now() };
  try {
    await offlineDb.outbox.put(entry);
  } catch (err) {
    if (isQuotaError(err)) {
      setStorageStatus('quota-exceeded');
      return; // surfaced via the banner; the in-memory Yjs doc keeps working regardless
    }
    throw err;
  }
}

/**
 * Replay every queued mutation in FIFO order. Stops at the first failure
 * that isn't "this entry is moot now" so entries after it keep their
 * relative order for the next attempt.
 */
export async function flushOutbox(onAccessRevoked?: () => void): Promise<void> {
  // `seq` (auto-increment) is the replay order, not `createdAt` — two
  // enqueues in the same millisecond would tie on createdAt and could
  // replay out of order, which matters when both target the same item.
  const entries = await offlineDb.outbox.orderBy('seq').toArray();
  for (const entry of entries) {
    try {
      await rpc.call(entry.method as RpcMethod, entry.params as RpcParams[RpcMethod]);
      await offlineDb.outbox.delete(entry.seq!);
    } catch (err) {
      if (
        err instanceof RpcClientError &&
        (err.code === 'version_conflict' || err.code === 'not_found')
      ) {
        // Superseded or already applied — exactly what "naturally idempotent"
        // buys us (RPC_QUEUEABLE_METHODS): drop it, not a replay failure.
        await offlineDb.outbox.delete(entry.seq!);
        continue;
      }
      if (err instanceof RpcClientError && err.code === 'unauthorized') {
        // Offline-access-loss (ADR-0014): the server is the authority that
        // rejected this replay. Purge best-effort and let the caller show a
        // "signed out" state — never silently keep retrying a dead session.
        await offlineDb.outbox.clear();
        onAccessRevoked?.();
        return;
      }
      if (
        err instanceof RpcClientError &&
        (err.code === 'bad_request' || err.code === 'forbidden')
      ) {
        // A malformed or now-forbidden replay will never succeed on retry —
        // drop it rather than block every entry queued after it forever.
        console.error('discarding a permanently-failing queued mutation', entry, err);
        await offlineDb.outbox.delete(entry.seq!);
        continue;
      }
      // Still offline, or a transient server error (rate_limited, conflict,
      // internal): stop here and retry the whole remaining queue, in order,
      // on the next reconnect signal.
      return;
    }
  }
}

/**
 * Wire the required foreground replay triggers (offline-and-pwa.md: online/
 * visibility events are the baseline everywhere; Background Sync — Chrome-
 * only — would be an optimization on top, not implemented here since a
 * generated service worker with no custom `sync` handler would otherwise
 * silently do nothing).
 */
export function registerReconnectFlush(onAccessRevoked?: () => void): () => void {
  const flush = (): void => void flushOutbox(onAccessRevoked);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && navigator.onLine) flush();
  };
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', onVisible);
  if (navigator.onLine) flush(); // covers the "already online at startup with a leftover queue" case
  return () => {
    window.removeEventListener('online', flush);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
