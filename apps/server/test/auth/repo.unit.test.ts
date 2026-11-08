import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPgAuthStore } from '../../src/modules/auth/repo.js';

/** pg 저장소의 매핑·바인딩 형태만 본다(실DB 동작은 int 테스트). */
function fakePool(rows: readonly unknown[]): { pool: pg.Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

const at = new Date('2026-11-07T00:00:00Z');
const sessionRow = { id: 's', user_id: 'u', token_hash: 'h', created_at: at, last_seen_at: at, expires_at: at, revoked_at: null };

describe('createPgAuthStore', () => {
  it('maps user rows and defaults a missing role to member', async () => {
    const { pool, calls } = fakePool([{ id: 'u', email_norm: 'a@b', display_name: 'A', password_hash: 'p', status: 'active', kind: 'human', role: null }]);
    const store = createPgAuthStore(pool);
    expect((await store.findUserByEmail('a@b'))?.role).toBe('member');
    expect((await store.findUserById('u'))?.emailNorm).toBe('a@b');
    expect(calls.map((c) => c.params)).toEqual([['a@b'], ['u']]);
  });

  it('returns undefined when no row matches', async () => {
    const store = createPgAuthStore(fakePool([]).pool);
    expect(await store.findUserByEmail('x')).toBeUndefined();
    expect(await store.findUserById('x')).toBeUndefined();
    expect(await store.findSessionByTokenHash('x')).toBeUndefined();
  });

  it('maps sessions and binds every write as parameters', async () => {
    const { pool, calls } = fakePool([sessionRow]);
    const store = createPgAuthStore(pool);
    const session = await store.findSessionByTokenHash('h');
    expect(session).toEqual({ id: 's', userId: 'u', tokenHash: 'h', createdAt: at, lastSeenAt: at, expiresAt: at, revokedAt: null });
    if (session === undefined) throw new Error('unreachable');
    await store.insertSession(session);
    await store.touchSession('s', at, at);
    await store.revokeSession('s', at);
    expect(await store.listLiveSessions('u', at)).toHaveLength(1);
    expect(calls.slice(1).map((c) => c.params.length)).toEqual([7, 3, 2, 2]);
  });
});
