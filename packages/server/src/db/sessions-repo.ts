import type { Db } from './db.js';

/** Killable server-side session store (ADR-0014). */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function createSession(
  db: Db,
  userId: string,
  ttlMs: number,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, expires_at, user_agent, ip)
     VALUES ($1, now() + ($2::bigint || ' milliseconds')::interval, $3, $4)
     RETURNING id`,
    [userId, String(ttlMs), meta.userAgent ?? null, meta.ip ?? null],
  );
  return res.rows[0]!.id;
}

/**
 * Resolve a session id to its live user, or null if the session is missing,
 * revoked, or expired. This is the check run on EVERY REST request and every
 * Hocuspocus re-auth — revocation (a single UPDATE/DELETE) is effective on the
 * very next call here, with no token-expiry lag (ADR-0014).
 */
export async function resolveSession(
  db: Db,
  sessionId: string,
): Promise<{ userId: string } | null> {
  // A session id arrives as a raw client-controlled cookie value (REST) or WS
  // handshake cookie — it is untrusted input, not yet known to be a UUID. Guard
  // before the query so a malformed value returns "no session" instead of a raw
  // Postgres "invalid input syntax for type uuid" error surfacing as a 500 / a
  // WS connection crash.
  if (!UUID_RE.test(sessionId)) return null;
  const res = await db.query<{ user_id: string }>(
    `UPDATE sessions SET last_seen_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sessionId],
  );
  const row = res.rows[0];
  return row ? { userId: row.user_id } : null;
}

/** Revoke one session (logout). Idempotent. */
export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
  ]);
}

/** Revoke every live session for a user (full kill switch). Returns the ids dropped. */
export async function revokeAllSessionsForUser(db: Db, userId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [userId],
  );
  return res.rows.map((r) => r.id);
}
