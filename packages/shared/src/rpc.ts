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
  'Signup',
  'Login',
  'Logout',
  'GetItems',
  'GetChildren',
  'UpdateItem',
  'CreateDocument',
  'ListDocuments',
  'InviteMember',
  'RemoveMember',
  'PresignUpload',
  'FinalizeUpload',
  'PresignDownload',
  'WhoAmI',
  'ExportDocument',
  'ImportDocument',
  'SearchItems',
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
  Signup: { email: string; password: string; displayName?: string; workspaceName?: string };
  Login: { email: string; password: string };
  Logout: Record<string, never>;
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
  PresignUpload: { documentId: string; itemId?: string; mime: string; size: number };
  FinalizeUpload: { attachmentId: string; documentId: string };
  PresignDownload: { attachmentId: string; documentId: string };
  WhoAmI: Record<string, never>;
  ExportDocument: { documentId: string; format: 'markdown' | 'json' };
  ImportDocument: { workspaceId: string; title?: string; data: ExportedDocument };
  SearchItems: { documentId: string; query: string };
}

/** Result per method. */
export interface RpcResult {
  // Session is established via a Set-Cookie response header, not the JSON body
  // (the session cookie is httpOnly — see docs/adr/0014). The body only echoes
  // identity plus the CSRF token the client must echo back on later mutations.
  Signup: { userId: string; csrfToken: string };
  Login: { userId: string; csrfToken: string };
  Logout: Record<string, never>;
  GetItems: { items: ItemView[] };
  GetChildren: { items: ItemView[] };
  UpdateItem: { item: ItemView };
  CreateDocument: { documentId: string; rootItemId: string };
  ListDocuments: { documents: { id: string; title: string }[] };
  InviteMember: { userId: string };
  RemoveMember: Record<string, never>;
  PresignUpload: { attachmentId: string; url: string; expiresInSec: number };
  FinalizeUpload: { attachment: AttachmentView };
  PresignDownload: { url: string; expiresInSec: number };
  WhoAmI: { userId: string; workspaceIds: string[] };
  ExportDocument: { content: string };
  ImportDocument: { documentId: string; rootItemId: string };
  SearchItems: { items: ItemView[] };
}

/** Attachment metadata as returned by RPC (no s3_key — server-internal). */
export interface AttachmentView {
  readonly id: string;
  readonly documentId: string;
  readonly itemId: string | null;
  readonly mime: string;
  readonly size: number;
  readonly checksum: string;
  readonly uploadedAt: string;
}

/** Exported item node (JSON full-fidelity format, ADR-0016). */
export interface ExportedItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly rank: string;
  readonly type: string;
  readonly content: string;
  readonly note: string | null;
  readonly isCompleted: boolean;
  readonly isCollapsed: boolean;
}

/** Top-level JSON export envelope (ADR-0016). */
export interface ExportedDocument {
  readonly version: 1;
  readonly exportedAt: string;
  readonly items: ExportedItem[];
}

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && (RPC_METHODS as readonly string[]).includes(value);
}

/**
 * Methods that don't require an existing session — the ones that establish one.
 * Every other method requires a resolved session (`unauthorized` otherwise).
 */
export const RPC_PUBLIC_METHODS: readonly RpcMethod[] = ['Signup', 'Login'];

/**
 * Methods that only read state. Exempt from CSRF (no side effect to forge) and
 * safe to fail fast offline rather than queue (offline-and-pwa.md).
 */
export const RPC_READ_METHODS: readonly RpcMethod[] = [
  'GetItems',
  'GetChildren',
  'ListDocuments',
  'WhoAmI',
  'ExportDocument',
  'SearchItems',
];

/**
 * Mutations that are naturally idempotent under blind retry (optimistic
 * concurrency or `ON CONFLICT DO NOTHING` on the server), so the offline
 * mutation outbox (`OFF`) may queue and replay them by client-generated
 * `requestId` without a server-side dedup ledger. Methods outside this set
 * (e.g. `CreateDocument`) are not safe to retry blindly and must fail fast
 * offline instead of queuing.
 */
export const RPC_QUEUEABLE_METHODS: readonly RpcMethod[] = [
  'UpdateItem',
  'InviteMember',
  'RemoveMember',
];

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
