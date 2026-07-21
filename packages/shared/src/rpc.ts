/**
 * `/rpc` command + error envelope types (api-and-write-path.md).
 *
 * The non-CRDT API is a single `POST /rpc` endpoint dispatching typed commands
 * (queries, auth, presign, workspace/settings). Structure and text ride the Yjs
 * plane; this surface wraps reads, auth, presign, and pure-metadata UpdateItem
 * (optimistic concurrency via `version`).
 *
 * These are the wire types both client and server import so the contract is
 * authored once. Handler logic lives in the server package.
 */

import type { ItemType } from './yjs-schema.js';

/** Stable, machine-readable error codes for the typed error envelope. */
export const RPC_ERROR_CODES = [
  'bad_request', // malformed params / failed validation
  'unauthorized', // no/!invalid session
  'forbidden', // authenticated but not a member of the target workspace/doc
  'not_found', // target entity does not exist (or is filtered by tenancy)
  'version_conflict', // optimistic-concurrency mismatch on UpdateItem
  'rate_limited', // too many requests (login/presign/connect)
  'conflict', // generic state conflict
  'internal', // unexpected server error
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export interface RpcError {
  readonly code: RpcErrorCode;
  readonly message: string;
  /** Optional structured detail (e.g. { expected, actual } for version_conflict). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A single dispatched command: a method name + typed params. */
export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  readonly method: M;
  readonly params: RpcParams[M];
  /** Client-generated id for idempotent retries (offline outbox replay). */
  readonly requestId: string;
}

export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | { readonly ok: true; readonly result: RpcResult[M] }
  | { readonly ok: false; readonly error: RpcError };

// --- Method catalog ---------------------------------------------------------

export const RPC_METHODS = [
  'GetItems',
  'GetChildren',
  'UpdateItem',
  'CreateDocument',
  'ListDocuments',
  'InviteMember',
  'RemoveMember',
  'PresignUpload',
  'PresignDownload',
  'WhoAmI',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

/** Projected item as returned by read commands (relational projection row). */
export interface ItemView {
  readonly id: string;
  readonly documentId: string;
  readonly parentId: string | null; // null = synthetic root
  readonly rank: string;
  readonly type: ItemType;
  readonly content: string;
  readonly note: string | null;
  readonly isCompleted: boolean;
  readonly isCollapsed: boolean;
  readonly version: number;
}

/** Params per method. */
export interface RpcParams {
  GetItems: { documentId: string; depth?: number };
  GetChildren: { documentId: string; parentId: string | null; depth?: number };
  // Pure content/metadata only — structural fields stay CRDT-only (ADR-0010).
  UpdateItem: {
    documentId: string;
    id: string;
    version: number;
    fields: Partial<{
      note: string | null;
      color: string | null;
      metadata: Record<string, unknown>;
    }>;
  };
  CreateDocument: { workspaceId: string; title?: string };
  ListDocuments: { workspaceId: string };
  InviteMember: { workspaceId: string; email: string };
  RemoveMember: { workspaceId: string; userId: string };
  PresignUpload: { documentId: string; mime: string; size: number };
  PresignDownload: { attachmentId: string };
  WhoAmI: Record<string, never>;
}

/** Result per method. */
export interface RpcResult {
  GetItems: { items: ItemView[] };
  GetChildren: { items: ItemView[] };
  UpdateItem: { item: ItemView };
  CreateDocument: { documentId: string; rootItemId: string };
  ListDocuments: { documents: { id: string; title: string }[] };
  InviteMember: { userId: string };
  RemoveMember: Record<string, never>;
  PresignUpload: { attachmentId: string; url: string; expiresInSec: number };
  PresignDownload: { url: string; expiresInSec: number };
  WhoAmI: { userId: string; workspaceIds: string[] };
}

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && (RPC_METHODS as readonly string[]).includes(value);
}

export function rpcOk<M extends RpcMethod>(result: RpcResult[M]): RpcResponse<M> {
  return { ok: true, result };
}

export function rpcErr<M extends RpcMethod>(
  code: RpcErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RpcResponse<M> {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}
