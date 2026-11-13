import type pg from 'pg';
import type { AuthStore, SessionListing, SessionRecord, UserRecord } from './store.js';

/** auth 저장소의 pg 구현. 모든 SQL은 파라미터 바인딩만 쓴다. */
interface UserRow {
  id: string;
  email_norm: string;
  display_name: string;
  password_hash: string | null;
  status: 'active' | 'disabled';
  kind: 'human' | 'bot';
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

const USER_SELECT = `SELECT u.id, u.email_norm, u.display_name, u.password_hash, u.status, u.kind,
  (SELECT m.role FROM workspace_members m WHERE m.user_id = u.id ORDER BY m.role = 'owner' DESC LIMIT 1) AS role
  FROM users u`;

const SESSION_COLUMNS = 'id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at';

interface SessionListingRow extends SessionRow {
  device_label: string | null;
}

export class UserInvariantError extends Error {
  override readonly name = 'UserInvariantError';
}

/**
 * 행 → 판별 유니온. 사람인데 해시가 없거나 봇인데 해시가 있으면 DB CHECK가 막지만, 타입 경계에서도 거부한다
 * (오류 문구에 행 값을 넣지 않는다).
 */
function toUser(row: UserRow): UserRecord {
  const base = {
    id: row.id,
    emailNorm: row.email_norm,
    displayName: row.display_name,
    status: row.status,
    role: row.role ?? 'member',
  } as const;
  if (row.kind === 'bot' && row.password_hash === null) return { ...base, kind: 'bot', passwordHash: null };
  if (row.kind === 'human' && row.password_hash !== null) return { ...base, kind: 'human', passwordHash: row.password_hash };
  throw new UserInvariantError('users 행의 kind·password_hash 불변식 위반');
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
    async insertSession(s, deviceLabel) {
      const values = [s.id, s.userId, s.tokenHash, s.createdAt, s.lastSeenAt, s.expiresAt, s.revokedAt];
      if (deviceLabel === undefined) {
        await pool.query(`INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`, values);
        return;
      }
      await pool.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}, device_label) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [...values, deviceLabel],
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
      // 로그아웃·세션 폐기 시 그 기기의 push 구독도 함께 지운다(TRD §2 push_subscriptions, §6-2).
      await pool.query(
        `WITH revoked AS (UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id)
         DELETE FROM push_subscriptions WHERE session_id = $1`,
        [id, revokedAt],
      );
    },
    async listLiveSessions(userId, now) {
      const res = await pool.query<SessionListingRow>(
        `SELECT ${SESSION_COLUMNS}, device_label FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
         ORDER BY last_seen_at DESC`,
        [userId, now],
      );
      return res.rows.map((row): SessionListing => ({ ...toSession(row), deviceLabel: row.device_label ?? null }));
    },
    async findUserSession(userId, id) {
      const res = await pool.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1 AND user_id = $2`, [id, userId]);
      return res.rows[0] === undefined ? undefined : toSession(res.rows[0]);
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
