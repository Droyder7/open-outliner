import type { Db, TxClient } from './db.js';

/** Tenancy: workspaces, documents, membership. */

export interface WorkspaceRow {
  id: string;
  owner_id: string;
  name: string;
}

export interface DocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  root_item_id: string | null;
}

export async function createUser(
  db: Db,
  email: string,
  displayName: string | null,
  passwordHash: string | null,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, displayName, passwordHash],
  );
  return res.rows[0]!.id;
}

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ id: string; password_hash: string | null } | null> {
  const res = await db.query<{ id: string; password_hash: string | null }>(
    `SELECT id, password_hash FROM users WHERE email = $1`,
    [email],
  );
  return res.rows[0] ?? null;
}

/** Create a workspace and seat its owner in workspace_members, atomically. */
export async function createWorkspace(db: Db, ownerId: string, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    const ws = await tx.query<{ id: string }>(
      `INSERT INTO workspaces (owner_id, name) VALUES ($1, $2) RETURNING id`,
      [ownerId, name],
    );
    const workspaceId = ws.rows[0]!.id;
    await tx.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, ownerId],
    );
    return workspaceId;
  });
}

export async function addMember(db: Db, workspaceId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [workspaceId, userId],
  );
}

/**
 * Remove a member and, in the same transaction, revoke their live sessions —
 * the authoritative kill switch (ADR-0014). The owner cannot be removed here.
 * Returns the user's revoked session ids so callers can drop live WS connections.
 */
export async function removeMember(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<{ removed: boolean; revokedSessionIds: string[] }> {
  return db.transaction(async (tx) => {
    const del = await tx.query(
      `DELETE FROM workspace_members
        WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'`,
      [workspaceId, userId],
    );
    if (del.rowCount === 0) return { removed: false, revokedSessionIds: [] };

    // If the user now belongs to no workspace at all, kill their sessions so the
    // live WS is dropped on the next re-auth and any offline replay is rejected.
    const stillMember = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workspace_members WHERE user_id = $1`,
      [userId],
    );
    let revokedSessionIds: string[] = [];
    if (Number.parseInt(stillMember.rows[0]!.n, 10) === 0) {
      const revoked = await tx.query<{ id: string }>(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL
          RETURNING id`,
        [userId],
      );
      revokedSessionIds = revoked.rows.map((r) => r.id);
    }
    return { removed: true, revokedSessionIds };
  });
}

export async function isWorkspaceMember(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  return res.rows.length > 0;
}

/** Is the user a member of the workspace that owns this document? (WS/RPC gate) */
export async function canAccessDocument(
  db: Db,
  documentId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.query<{ one: number }>(
    `SELECT 1 AS one
       FROM documents d
       JOIN workspace_members m ON m.workspace_id = d.workspace_id
      WHERE d.id = $1 AND m.user_id = $2`,
    [documentId, userId],
  );
  return res.rows.length > 0;
}

export async function listWorkspaceIdsForUser(db: Db, userId: string): Promise<string[]> {
  const res = await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members WHERE user_id = $1`,
    [userId],
  );
  return res.rows.map((r) => r.workspace_id);
}

export async function listDocuments(
  db: Db,
  workspaceId: string,
): Promise<{ id: string; title: string }[]> {
  const res = await db.query<{ id: string; title: string }>(
    `SELECT id, title FROM documents WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  return res.rows;
}

/**
 * Create a document and its synthetic root item, atomically. The root item's
 * CRDT state is authored client-side; here we only seed the projection row and
 * wire `documents.root_item_id`.
 */
export async function createDocument(
  db: Db,
  workspaceId: string,
  title: string,
  rootItemId: string,
  rootRank: string,
): Promise<string> {
  return db.transaction(async (tx: TxClient) => {
    const doc = await tx.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title) VALUES ($1, $2) RETURNING id`,
      [workspaceId, title],
    );
    const documentId = doc.rows[0]!.id;
    await tx.query(
      `INSERT INTO items (id, document_id, parent_id, rank, type, content)
       VALUES ($1, $2, NULL, $3, 'bullet', '')`,
      [rootItemId, documentId, rootRank],
    );
    await tx.query(`UPDATE documents SET root_item_id = $1 WHERE id = $2`, [
      rootItemId,
      documentId,
    ]);
    // Seed the projection bookkeeping row (ADR-0013).
    await tx.query(
      `INSERT INTO document_projection (document_id, source_rev, projected_rev)
       VALUES ($1, 0, 0) ON CONFLICT (document_id) DO NOTHING`,
      [documentId],
    );
    return documentId;
  });
}
