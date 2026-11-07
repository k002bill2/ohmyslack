import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ACCEPT_INVITE_SQL, createPgMembersStore } from '../../src/modules/members/repo.js';

/** pg 저장소의 SQL·트랜잭션 제어 흐름만 본다(실DB 원자성은 int 테스트). 응답은 SQL 앞부분으로 고른다. */
type Responder = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

function fakePool(respond: Responder) {
  const log: string[] = [];
  let released = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    return respond(sql, params);
  };
  const pool = { query, connect: async () => ({ query, release: () => (released += 1) }) } as unknown as pg.Pool;
  return { pool, log, released: () => released };
}

const ok = (rows: unknown[] = [{}]) => ({ rows, rowCount: rows.length });
const member = { id: 'u', emailNorm: 'a@b', displayName: 'A', passwordHash: 'stored-phc' };

describe('createPgMembersStore', () => {
  it('수락 UPDATE는 used_at·revoked_at·만료 조건으로 1회만 교환한다', () => {
    expect(ACCEPT_INVITE_SQL).toMatch(/used_at IS NULL AND revoked_at IS NULL AND expires_at > \$2/);
  });

  it('수락: invite 없음 → ROLLBACK, 이메일 충돌 → token 소모 COMMIT(W-15 F-3), 성공 → COMMIT', async () => {
    const none = fakePool((sql) => (sql.startsWith('UPDATE invites') ? ok([]) : ok()));
    expect(await createPgMembersStore(none.pool).acceptInvite('h', new Date(), member)).toEqual({ ok: false });
    expect(none.log.at(-1)).toBe('ROLLBACK');
    const dup = fakePool((sql) => (sql.startsWith('INSERT INTO users') ? ok([]) : ok()));
    expect(await createPgMembersStore(dup.pool).acceptInvite('h', new Date(), member)).toEqual({ ok: false });
    expect(dup.log.at(-1)).toBe('COMMIT');
    const noWs = fakePool((sql) => (sql.startsWith('INSERT INTO workspace_members') ? ok([]) : ok()));
    expect(await createPgMembersStore(noWs.pool).acceptInvite('h', new Date(), member)).toEqual({ ok: false });
    const good = fakePool(() => ok());
    expect(await createPgMembersStore(good.pool).acceptInvite('h', new Date(), member)).toEqual({ ok: true });
    expect(good.log.at(-1)).toBe('COMMIT');
    expect(good.released()).toBe(1);
  });

  it('트랜잭션 중 오류는 ROLLBACK 후 다시 던지고 연결을 돌려준다', async () => {
    const fx = fakePool((sql) => {
      if (sql.startsWith('UPDATE invites')) throw new Error('db down');
      return ok();
    });
    await expect(createPgMembersStore(fx.pool).acceptInvite('h', new Date(), member)).rejects.toThrow('db down');
    expect(fx.log.at(-1)).toBe('ROLLBACK');
    expect(fx.released()).toBe(1);
  });

  it('비활성화 분기: 없음·마지막 owner·actor 무효는 ROLLBACK, 성공은 세션 id를 돌려준다', async () => {
    const run = async (target: unknown[], others: number, actorOk: boolean) => {
      const fx = fakePool((sql) => {
        if (sql.includes('FROM users u WHERE u.id')) return ok(target);
        if (sql.includes('count(*)')) return ok([{ n: others }]);
        if (sql.includes('AS ok')) return ok([{ ok: actorOk }]);
        if (sql.startsWith('UPDATE sessions')) return ok([{ id: 's1' }]);
        return ok();
      });
      const result = await createPgMembersStore(fx.pool).deactivate('a', 't', new Date());
      return { result, last: fx.log.at(-1) };
    };
    expect(await run([], 1, true)).toEqual({ result: { ok: false, reason: 'not_found' }, last: 'ROLLBACK' });
    expect(await run([{ status: 'active', is_owner: true }], 0, true)).toEqual({
      result: { ok: false, reason: 'last_owner' },
      last: 'ROLLBACK',
    });
    expect(await run([{ status: 'active', is_owner: false }], 0, false)).toEqual({
      result: { ok: false, reason: 'forbidden' },
      last: 'ROLLBACK',
    });
    expect(await run([{ status: 'active', is_owner: true }], 1, true)).toEqual({
      result: { ok: true, revokedSessionIds: ['s1'] },
      last: 'COMMIT',
    });
  });

  it('발급·폐기·목록 매핑', async () => {
    const fx = fakePool((sql) =>
      sql.startsWith('SELECT u.id') ? ok([{ id: 'u', display_name: 'A', role: 'owner' }]) : { rows: [], rowCount: 0 },
    );
    const store = createPgMembersStore(fx.pool);
    await store.insertInvite({ id: 'i', tokenHash: 'h', createdBy: 'u', expiresAt: new Date() });
    expect(await store.revokeInvite('i', new Date())).toBe(false);
    expect(await store.listActiveMembers()).toEqual([{ id: 'u', displayName: 'A', role: 'owner' }]);
  });
});
