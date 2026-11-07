import type pg from 'pg';
import type { AuthStore, SessionRecord, UserRecord } from './store.js';

/** auth 저장소의 pg 구현. 모든 SQL은 파라미터 바인딩만 쓴다. */
interface UserRow {
  id: string;
  email_norm: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
  role: 'owner' | 'member' | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const USER_SELECT = `SELECT u.id, u.email_norm, u.display_name, u.password_hash, u.status,
  (SELECT m.role FROM workspace_members m WHERE m.user_id = u.id ORDER BY m.role = 'owner' DESC LIMIT 1) AS role
  FROM users u`;

const SESSION_COLUMNS = 'id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at';

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    emailNorm: row.email_norm,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status,
    role: row.role ?? 'member',
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createPgAuthStore(pool: pg.Pool): AuthStore {
  return {
    async findUserByEmail(emailNorm) {
      const res = await pool.query<UserRow>(`${USER_SELECT} WHERE u.email_norm = $1`, [emailNorm]);
      return res.rows[0] === undefined ? undefined : toUser(res.rows[0]);
    },
    async findUserById(id) {
      const res = await pool.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
      return res.rows[0] === undefined ? undefined : toUser(res.rows[0]);
    },
    async insertSession(s) {
      await pool.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.id, s.userId, s.tokenHash, s.createdAt, s.lastSeenAt, s.expiresAt, s.revokedAt],
      );
    },
    async findSessionByTokenHash(tokenHash) {
      const res = await pool.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = $1`, [tokenHash]);
      return res.rows[0] === undefined ? undefined : toSession(res.rows[0]);
    },
    async touchSession(id, lastSeenAt, expiresAt) {
      await pool.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1 AND revoked_at IS NULL', [
        id,
        lastSeenAt,
        expiresAt,
      ]);
    },
    async revokeSession(id, revokedAt) {
      await pool.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, revokedAt]);
    },
    async listLiveSessions(userId, now) {
      const res = await pool.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
         ORDER BY last_seen_at DESC`,
        [userId, now],
      );
      return res.rows.map(toSession);
    },
    async filterLiveSessionIds(ids, now, createdAfter) {
      if (ids.length === 0) return [];
      const res = await pool.query<{ id: string }>(
        `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ANY($1::uuid[]) AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.created_at > $3
           AND u.status = 'active'`,
        [ids, now, createdAfter],
      );
      return res.rows.map((r) => r.id);
    },
  };
}
