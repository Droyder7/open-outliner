import type {
  AttachmentView,
  ItemView,
  RpcMethod,
  RpcParams,
  RpcResult,
} from '@open-outliner/shared';
import type { Db } from '../db/db.js';
import type { ItemRow } from '../db/items-repo.js';
import { getItemById, getSubtree, getLiveItems, updateItemMetadata } from '../db/items-repo.js';
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
import {
  createAttachment,
  finalizeAttachment,
  getAttachmentForDownload,
} from '../db/attachments-repo.js';
import { createSession, revokeSession } from '../db/sessions-repo.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateCsrfToken } from '../http/csrf.js';
import type { ServerConfig } from '../config.js';
import { RpcHandlerError } from './errors.js';
import type { CookieOptions } from '../http/cookies.js';
import type { RateLimiter } from '../http/rate-limit.js';
import type { S3Service } from '../storage/s3.js';
import {
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  PUT_PRESIGN_TTL_SEC,
  GET_PRESIGN_TTL_SEC,
} from '../storage/s3.js';
import { serializeMarkdown, serializeJson, importDocument } from '../export/serializer.js';

export interface RpcContext {
  readonly db: Db;
  readonly config: ServerConfig;
  readonly s3?: S3Service | undefined;
  readonly session: { userId: string; sessionId: string } | null;
  readonly ip: string;
  readonly userAgent?: string;
  readonly rateLimiters: { login: RateLimiter; presign: RateLimiter };
  readonly effects: {
    setCookies: { name: string; value: string; opts: CookieOptions }[];
    revokedSessionIds: string[];
  };
}

function requireSession(ctx: RpcContext): { userId: string; sessionId: string } {
  if (!ctx.session) throw new RpcHandlerError('unauthorized', 'No active session');
  return ctx.session;
}

function requireS3(ctx: RpcContext): S3Service {
  if (!ctx.s3) throw new RpcHandlerError('internal', 'Attachment storage is not configured');
  return ctx.s3;
}

async function requireWorkspaceMember(
  ctx: RpcContext,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!(await isWorkspaceMember(ctx.db, workspaceId, userId))) {
    throw new RpcHandlerError('forbidden', 'Not a member of this workspace');
  }
}

async function requireDocumentAccess(
  ctx: RpcContext,
  documentId: string,
  userId: string,
): Promise<void> {
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

export type RpcHandler<M extends RpcMethod> = (
  params: RpcParams[M],
  ctx: RpcContext,
) => Promise<RpcResult[M]>;

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
    ctx.effects.setCookies.push({
      name: ctx.config.sessionCookieName,
      value: '',
      opts: { expiresNow: true },
    });
    ctx.effects.setCookies.push({
      name: ctx.config.csrfCookieName,
      value: '',
      opts: { expiresNow: true },
    });
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
    const updated = await updateItemMetadata(
      ctx.db,
      params.documentId,
      params.id,
      params.version,
      params.fields,
    );
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
    const invited = await findUserByEmail(ctx.db, email);
    let invitedUserId: string;
    if (invited) {
      invitedUserId = invited.id;
    } else {
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

  async PresignUpload(params, ctx) {
    const { userId } = requireSession(ctx);
    if (!ctx.rateLimiters.presign.check(userId)) {
      throw new RpcHandlerError('rate_limited', 'Too many presign requests, try again later');
    }
    const s3 = requireS3(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);

    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(params.mime)) {
      throw new RpcHandlerError('bad_request', `MIME type not allowed: ${params.mime}`);
    }
    if (params.size <= 0 || params.size > MAX_ATTACHMENT_BYTES) {
      throw new RpcHandlerError(
        'bad_request',
        `File size must be between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes`,
      );
    }

    const attachmentId = await createAttachment(
      ctx.db,
      params.documentId,
      params.itemId ?? null,
      params.mime,
      params.size,
    );
    const s3Key = s3.s3Key(params.documentId, attachmentId);
    const url = await s3.presignPut(s3Key, params.mime, params.size);

    return { attachmentId, url, expiresInSec: PUT_PRESIGN_TTL_SEC };
  },

  async FinalizeUpload(params, ctx) {
    const { userId } = requireSession(ctx);
    const s3 = requireS3(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);

    const s3Key = s3.s3Key(params.documentId, params.attachmentId);
    const head = await s3.headObject(s3Key);
    if (!head) {
      throw new RpcHandlerError('not_found', 'Upload not found in storage — upload first');
    }

    const checksum = head.etag;
    const row = await finalizeAttachment(
      ctx.db,
      params.attachmentId,
      params.documentId,
      s3Key,
      head.size,
      checksum,
    );
    if (!row) {
      throw new RpcHandlerError(
        'not_found',
        'Attachment not found, already finalized, or deleted',
      );
    }

    const view: AttachmentView = {
      id: row.id,
      documentId: row.document_id,
      itemId: row.item_id,
      mime: row.mime,
      size: Number(row.size),
      checksum: row.checksum,
      uploadedAt: row.uploaded_at!.toISOString(),
    };
    return { attachment: view };
  },

  async PresignDownload(params, ctx) {
    const { userId } = requireSession(ctx);
    if (!ctx.rateLimiters.presign.check(userId)) {
      throw new RpcHandlerError('rate_limited', 'Too many presign requests, try again later');
    }
    const s3 = requireS3(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);

    const row = await getAttachmentForDownload(ctx.db, params.attachmentId, params.documentId);
    if (!row || !row.s3_key) {
      throw new RpcHandlerError('not_found', 'Attachment not found or not yet uploaded');
    }

    const url = await s3.presignGet(row.s3_key);
    return { url, expiresInSec: GET_PRESIGN_TTL_SEC };
  },

  async ExportDocument(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);

    const rows = await getLiveItems(ctx.db, params.documentId);
    const content =
      params.format === 'markdown'
        ? serializeMarkdown(rows)
        : serializeJson(params.documentId, rows);
    return { content };
  },

  async ImportDocument(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireWorkspaceMember(ctx, params.workspaceId, userId);

    if (
      !params.data ||
      typeof params.data !== 'object' ||
      params.data.version !== 1 ||
      !Array.isArray(params.data.items)
    ) {
      throw new RpcHandlerError('bad_request', 'Invalid export data: expected version 1 JSON');
    }

    const { documentId, rootItemId } = await importDocument(
      ctx.db,
      params.workspaceId,
      params.title ?? 'Imported Document',
      params.data,
    );
    return { documentId, rootItemId };
  },

  async SearchItems(params, ctx) {
    const { userId } = requireSession(ctx);
    await requireDocumentAccess(ctx, params.documentId, userId);

    const query = params.query.trim().toLowerCase();
    if (query.length === 0) return { items: [] };

    const rows = await getLiveItems(ctx.db, params.documentId);
    const matched = rows.filter(
      (r) =>
        r.content.toLowerCase().includes(query) ||
        (r.note !== null && r.note.toLowerCase().includes(query)),
    );
    return { items: matched.map(toItemView) };
  },
};
