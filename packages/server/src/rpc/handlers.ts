import type { ItemView, RpcMethod, RpcParams, RpcResult } from '@open-outliner/shared';
import type { Db } from '../db/db.js';
import type { ItemRow } from '../db/items-repo.js';
import { getItemById, getSubtree, updateItemMetadata } from '../db/items-repo.js';
import {
  addMember,
  canAccessDocument,
  createDocumentWithRoot,
  createUser,
  createWorkspace,
  findUserByEmail,
  isWorkspaceMember,
  listDocuments,
  listWorkspaceIdsForUser,
  removeMember,
} from '../db/tenancy-repo.js';
import { createSession, revokeSession } from '../db/sessions-repo.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateCsrfToken } from '../http/csrf.js';
import type { ServerConfig } from '../config.js';
import { RpcHandlerError } from './errors.js';
import type { CookieOptions } from '../http/cookies.js';
import type { RateLimiter } from '../http/rate-limit.js';

/**
 * Everything a handler needs, and the side channel for effects the transport
 * layer must apply (cookies, connection revocation) that don't belong in the
 * typed `RpcResult` body. Keeping handlers pure functions of
 * `(params, ctx) => result` (throwing `RpcHandlerError` for typed failures)
 * is what makes `dispatch()` a single, uniform place to turn either into an
 * `RpcResponse` envelope.
 */
export interface RpcContext {
  readonly db: Db;
  readonly config: ServerConfig;
  readonly session: { userId: string; sessionId: string } | null;
  readonly ip: string;
  readonly userAgent?: string;
  readonly rateLimiters: { login: RateLimiter; presign: RateLimiter };
  readonly effects: {
    setCookies: { name: string; value: string; opts: CookieOptions }[];
    /** Session ids just revoked — the caller drops their live Hocuspocus sockets (ADR-0014). */
    revokedSessionIds: string[];
  };
}

function requireSession(ctx: RpcContext): { userId: string; sessionId: string } {
  if (!ctx.session) throw new RpcHandlerError('unauthorized', 'No active session');
  return ctx.session;
}

async function requireWorkspaceMember(ctx: RpcContext, workspaceId: string, userId: string): Promise<void> {
  if (!(await isWorkspaceMember(ctx.db, workspaceId, userId))) {
    throw new RpcHandlerError('forbidden', 'Not a member of this workspace');
  }
}

async function requireDocumentAccess(ctx: RpcContext, documentId: string, userId: string): Promise<void> {
  if (!(await canAccessDocument(ctx.db, documentId, userId))) {
    throw new RpcHandlerError('forbidden', 'Not a member of the workspace that owns this document');
  }
}

function toItemView(row: ItemRow): ItemView {
  return {
    id: row.id,
    documentId: row.document_id,
    parentId: row.parent_id,
    rank: row.rank,
    type: row.type,
    content: row.content,
    note: row.note,
    isCompleted: row.is_completed,
    isCollapsed: row.is_collapsed,
    version: Number(row.version),
  };
}

/** Issue a fresh session + CSRF cookie pair for `userId` and queue them as effects. */
async function issueSession(ctx: RpcContext, userId: string): Promise<{ csrfToken: string }> {
  const sessionId = await createSession(ctx.db, userId, ctx.config.sessionTtlMs, {
    ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    ip: ctx.ip,
  });
  const csrfToken = generateCsrfToken();
  const maxAgeSec = Math.floor(ctx.config.sessionTtlMs / 1000);
  ctx.effects.setCookies.push({
    name: ctx.config.sessionCookieName,
    value: sessionId,
    opts: { httpOnly: true, sameSite: 'Lax', maxAgeSec },
  });
  ctx.effects.setCookies.push({
    name: ctx.config.csrfCookieName,
    value: csrfToken,
    opts: { httpOnly: false, sameSite: 'Lax', maxAgeSec },
  });
  return { csrfToken };
}

export type RpcHandler<M extends RpcMethod> = (params: RpcParams[M], ctx: RpcContext) => Promise<RpcResult[M]>;

export const handlers: { [M in RpcMethod]: RpcHandler<M> } = {
  async Signup(params, ctx) {
    if (!ctx.rateLimiters.login.check(ctx.ip)) {
      throw new RpcHandlerError('rate_limited', 'Too many attempts, try again later');
    }
    const email = params.email.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new RpcHandlerError('bad_request', 'Invalid email');
    if (!params.password || params.password.length < 8) {
      throw new RpcHandlerError('bad_request', 'Password must be at least 8 characters');
    }
    if (await findUserByEmail(ctx.db, email)) {
      throw new RpcHandlerError('conflict', 'An account with this email already exists');
    }
    const passwordHash = await hashPassword(params.password);
    const userId = await createUser(ctx.db, email, params.displayName ?? null, passwordHash);
    await createWorkspace(ctx.db, userId, params.workspaceName ?? 'My Workspace');
    const { csrfToken } = await issueSession(ctx, userId);
    return { userId, csrfToken };
  },

  async Login(params, ctx) {
    if (!ctx.rateLimiters.login.check(ctx.ip)) {
      throw new RpcHandlerError('rate_limited', 'Too many attempts, try again later');
    }
    const email = params.email.trim().toLowerCase();
    const user = await findUserByEmail(ctx.db, email);
    // Constant-shape failure: verify against a dummy hash when the user is
    // absent so the response timing doesn't reveal account existence.
    const ok = user?.password_hash
      ? await verifyPassword(params.password, user.password_hash)
      : await verifyPassword(params.password, await hashPassword('dummy-password-for-timing'));
    if (!user || !ok) throw new RpcHandlerError('unauthorized', 'Invalid email or password');
    const { csrfToken } = await issueSession(ctx, user.id);
    return { userId: user.id, csrfToken };
  },

  async Logout(_params, ctx) {
    if (ctx.session) {
      await revokeSession(ctx.db, ctx.session.sessionId);
      ctx.effects.revokedSessionIds.push(ctx.session.sessionId);
    }
    ctx.effects.setCookies.push({ name: ctx.config.sessionCookieName, value: '', opts: { expiresNow: true } });
    ctx.effects.setCookies.push({ name: ctx.config.csrfCookieName, value: '', opts: { expiresNow: true } });
    return {};
  },

  async WhoAmI(_params, ctx) {
    const { userId } = requireSession(ctx);
    const workspaceIds = await listWorkspaceIdsForUser(ctx.db, userId);
    return { userId, workspaceIds };
  },

  async GetItems(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);
    const depth = params.depth ?? ctx.config.defaultDocDepth;
    const rows = await getSubtree(ctx.db, params.documentId, null, depth);
    return { items: rows.map(toItemView) };
  },

  async GetChildren(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);
    const depth = params.depth ?? ctx.config.defaultChildrenDepth;
    const rows = await getSubtree(ctx.db, params.documentId, params.parentId, depth);
    return { items: rows.map(toItemView) };
  },

  async UpdateItem(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);
    const updated = await updateItemMetadata(ctx.db, params.documentId, params.id, params.version, params.fields);
    if (updated) return { item: toItemView(updated) };
    const current = await getItemById(ctx.db, params.documentId, params.id);
    if (!current) throw new RpcHandlerError('not_found', 'Item not found');
    throw new RpcHandlerError('version_conflict', 'Item was modified by someone else', {
      expected: params.version,
      actual: current.version,
    });
  },

  async CreateDocument(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireWorkspaceMember(ctx, params.workspaceId, userId);
    const { documentId, rootItemId } = await createDocumentWithRoot(
      ctx.db,
      params.workspaceId,
      params.title ?? 'Untitled',
    );
    return { documentId, rootItemId };
  },

  async ListDocuments(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireWorkspaceMember(ctx, params.workspaceId, userId);
    const documents = await listDocuments(ctx.db, params.workspaceId);
    return { documents };
  },

  async InviteMember(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireWorkspaceMember(ctx, params.workspaceId, userId);
    const email = params.email.trim().toLowerCase();
    let invited = await findUserByEmail(ctx.db, email);
    let invitedUserId: string;
    if (invited) {
      invitedUserId = invited.id;
    } else {
      // Invited-but-not-yet-activated: created with no password; login is
      // impossible until the user sets one (out of scope here — signup flow
      // owns activation).
      invitedUserId = await createUser(ctx.db, email, null, null);
    }
    await addMember(ctx.db, params.workspaceId, invitedUserId);
    return { userId: invitedUserId };
  },

  async RemoveMember(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireWorkspaceMember(ctx, params.workspaceId, userId);
    const result = await removeMember(ctx.db, params.workspaceId, params.userId);
    if (result.revokedSessionIds.length > 0) {
      ctx.effects.revokedSessionIds.push(...result.revokedSessionIds);
    }
    return {};
  },

  async PresignUpload(_params, ctx) {
    const { userId } = requireSession(ctx);
    if (!ctx.rateLimiters.presign.check(userId)) {
      throw new RpcHandlerError('rate_limited', 'Too many presign requests, try again later');
    }
    // Attachments (S3/MinIO presign, checksum finalize) are Phase 8 (ATT) —
    // out of scope for Phases 5-7 per implementation-build-order-plan.md.
    throw new RpcHandlerError('internal', 'Attachments are not yet implemented (Phase 8 / ATT)');
  },

  async PresignDownload(_params, ctx) {
    const { userId } = requireSession(ctx);
    if (!ctx.rateLimiters.presign.check(userId)) {
      throw new RpcHandlerError('rate_limited', 'Too many presign requests, try again later');
    }
    throw new RpcHandlerError('internal', 'Attachments are not yet implemented (Phase 8 / ATT)');
  },
};
