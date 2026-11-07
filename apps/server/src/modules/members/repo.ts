import type pg from 'pg';
import type { AcceptResult, DeactivateResult, MemberSummary, MembersStore } from './store.js';

/** members 저장소의 pg 구현. 모든 SQL은 파라미터 바인딩만 쓴다. */
interface MemberRow {
  id: string;
  display_name: string;
  role: 'owner' | 'member';
}

/** 수락 UPDATE: 미사용·미폐기·미만료 token만 한 번 교환한다(동시 수락 중 1건만 RETURNING). */
export const ACCEPT_INVITE_SQL = `UPDATE invites SET used_at = $2
  WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2
  RETURNING id`;

/** 작업 결과의 `commit`이 false면 ROLLBACK 후 value만 돌려준다(거부 시 DB 무변경). */
interface TxOutcome<T> {
  readonly commit: boolean;
  readonly value: T;
}

async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await work(client);
    await client.query(outcome.commit ? 'COMMIT' : 'ROLLBACK');
    return outcome.value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function deactivateIn(client: pg.PoolClient, actorId: string, targetId: string, at: Date): Promise<DeactivateResult> {
  // 마지막 owner 판정(409)을 actor 재확인(403)보다 먼저 한다: 두 owner가 서로를 동시에 비활성화하면 뒤 요청은 S10 409.
  // owner 행을 먼저 잠가 owner를 바꾸는 비활성화를 직렬화한다. 이후 문장은 READ COMMITTED 새 스냅숏으로 다시 센다.
  await client.query("SELECT 1 FROM workspace_members WHERE role = 'owner' FOR UPDATE");
  const target = await client.query<{ status: string; is_owner: boolean }>(
    `SELECT u.status, EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.role = 'owner') AS is_owner
       FROM users u WHERE u.id = $1 FOR UPDATE`,
    [targetId],
  );
  const row = target.rows[0];
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (row.is_owner && row.status === 'active') {
    const others = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.role = 'owner' AND u.status = 'active' AND u.id <> $1`,
      [targetId],
    );
    if ((others.rows[0]?.n ?? 0) < 1) return { ok: false, reason: 'last_owner' };
  }
  const actor = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users u JOIN workspace_members m ON m.user_id = u.id
       WHERE u.id = $1 AND u.status = 'active' AND m.role = 'owner') AS ok`,
    [actorId],
  );
  if (actor.rows[0]?.ok !== true) return { ok: false, reason: 'forbidden' };
  await client.query("UPDATE users SET status = 'disabled' WHERE id = $1", [targetId]);
  const revoked = await client.query<{ id: string }>(
    'UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [targetId, at],
  );
  return { ok: true, revokedSessionIds: revoked.rows.map((r) => r.id) };
}

export function createPgMembersStore(pool: pg.Pool): MembersStore {
  return {
    async insertInvite(invite) {
      await pool.query('INSERT INTO invites (id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4)', [
        invite.id,
        invite.tokenHash,
        invite.createdBy,
        invite.expiresAt,
      ]);
    },
    async revokeInvite(id, at) {
      const res = await pool.query('UPDATE invites SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL AND used_at IS NULL', [id, at]);
      return (res.rowCount ?? 0) > 0;
    },
    async isInviteUsable(tokenHash, now) {
      const res = await pool.query(
        'SELECT 1 FROM invites WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2',
        [tokenHash, now],
      );
      return (res.rowCount ?? 0) > 0;
    },
    acceptInvite(tokenHash, now, member) {
      const rejected = { commit: false, value: { ok: false } } as const;
      return inTransaction<AcceptResult>(pool, async (client) => {
          const invite = await client.query(ACCEPT_INVITE_SQL, [tokenHash, now]);
          if ((invite.rowCount ?? 0) === 0) return rejected;
          const user = await client.query(
            `INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, $2, $3, $4, 'active')
             ON CONFLICT (email_norm) DO NOTHING RETURNING id`,
            [member.id, member.emailNorm, member.displayName, member.passwordHash],
          );
          if ((user.rowCount ?? 0) === 0) return rejected;
          const joined = await client.query(
            `INSERT INTO workspace_members (workspace_id, user_id, role)
             SELECT id, $1, 'member' FROM workspaces ORDER BY created_at, id LIMIT 1`,
            [member.id],
          );
          return (joined.rowCount ?? 0) === 0 ? rejected : { commit: true, value: { ok: true } };
      });
    },
    async listActiveMembers() {
      const res = await pool.query<MemberRow>(
        `SELECT u.id, u.display_name, m.role FROM users u JOIN workspace_members m ON m.user_id = u.id
         WHERE u.status = 'active' ORDER BY u.display_name, u.id`,
      );
      return res.rows.map((r): MemberSummary => ({ id: r.id, displayName: r.display_name, role: r.role }));
    },
    deactivate(actorId, targetId, at) {
      return inTransaction<DeactivateResult>(pool, async (client) => {
        const value = await deactivateIn(client, actorId, targetId, at);
        return { commit: value.ok, value };
      });
    },
  };
}
