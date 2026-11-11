import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ACCESS_SQL, createPgConversationsStore } from '../../src/modules/conversations/repo.js';

/** pg 저장소의 SQL·트랜잭션 제어 흐름만 본다(실DB 원자성은 int 테스트). 응답은 SQL 앞부분으로 고른다. */
type Responder = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

function fakePool(respond: Responder) {
  const log: string[] = [];
  const params: unknown[][] = [];
  let released = 0;
  const query = async (sql: string, args: unknown[] = []) => {
    log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    params.push(args);
    return respond(sql, args);
  };
  const pool = { query, connect: async () => ({ query, release: () => (released += 1), on: () => undefined, removeListener: () => undefined }) } as unknown as pg.Pool;
  return { pool, log, params, released: () => released };
}

const ok = (rows: unknown[] = [{}]) => ({ rows, rowCount: rows.length });
const none = () => ok([]);
const at = new Date(0);
const channel = { id: 'c1', name: 'General', nameNorm: 'general', creatorId: 'u1', at };
const dm = { id: 'd1', userId: 'u1', peerId: 'u2', pairKey: 'u1:u2', at };

/** 기본 응답: workspace 있음, last_seq 5, 그 외는 1행. */
function base(sql: string) {
  if (sql.startsWith('SELECT workspace_id')) return ok([{ workspace_id: 'w1' }]);
  if (sql.startsWith('SELECT last_seq')) return ok([{ last_seq: '5' }]);
  return ok();
}

describe('createPgConversationsStore: 접근·조회', () => {
  it('ACCESS_SQL은 현재 멤버십(left_at IS NULL)만 인정한다', () => {
    expect(ACCESS_SQL).toContain('m.left_at IS NULL');
  });

  it('findAccess: 행 → kind·activeMember, 없음 → undefined', async () => {
    const hit = fakePool(() => ok([{ kind: 'channel', active_member: true }]));
    expect(await createPgConversationsStore(hit.pool).findAccess('c', 'u')).toEqual({ kind: 'channel', activeMember: true });
    expect(hit.params[0]).toEqual(['c', 'u']);
    const miss = fakePool(none);
    expect(await createPgConversationsStore(miss.pool).findAccess('c', 'u')).toBeUndefined();
  });

  it('discover: after 미지정은 null로 넘기고 행을 매핑한다', async () => {
    const fx = fakePool(() => ok([{ id: 'c1', name: 'a', extra: 1 }]));
    const store = createPgConversationsStore(fx.pool);
    expect(await store.discover('u', undefined, 3)).toEqual([{ id: 'c1', name: 'a' }]);
    expect(fx.params[0]).toEqual(['u', null, 3]);
    await store.discover('u', 'c0', 3);
    expect(fx.params[1]).toEqual(['u', 'c0', 3]);
  });

  it('leave: 바뀐 행 유무로 true/false', async () => {
    expect(await createPgConversationsStore(fakePool(() => ok()).pool).leave('c', 'u', at)).toBe(true);
    expect(await createPgConversationsStore(fakePool(none).pool).leave('c', 'u', at)).toBe(false);
    const noCount = fakePool(() => ({ rows: [], rowCount: null as unknown as number }));
    expect(await createPgConversationsStore(noCount.pool).leave('c', 'u', at)).toBe(false);
  });

  it('listMembers·listForUser 매핑(bigint 문자열 → number)', async () => {
    const fx = fakePool((sql) => {
      if (sql.startsWith('SELECT u.id')) return ok([{ id: 'u', display_name: 'A' }]);
      return ok([{ id: 'c', kind: 'dm', name: null, last_seq: '12', last_read_seq: '7', peer_user_id: 'p' }]);
    });
    const store = createPgConversationsStore(fx.pool);
    expect(await store.listMembers('c')).toEqual([{ id: 'u', displayName: 'A' }]);
    expect(await store.listForUser('u', undefined, 101)).toEqual([{ id: 'c', kind: 'dm', name: null, peerUserId: 'p', peerKind: null, lastSeq: 12, lastReadSeq: 7 }]);
  });
});

describe('createPgConversationsStore: 채널 생성·참여', () => {
  it('workspace 없음 → ROLLBACK no_workspace', async () => {
    const fx = fakePool((sql) => (sql.startsWith('SELECT workspace_id') ? none() : base(sql)));
    expect(await createPgConversationsStore(fx.pool).createChannel(channel)).toEqual({ ok: false, reason: 'no_workspace' });
    expect(fx.log.at(-1)).toBe('ROLLBACK');
    expect(fx.released()).toBe(1);
  });

  it('이름 충돌(INSERT 0행) → ROLLBACK name_taken', async () => {
    const fx = fakePool((sql) => (sql.startsWith('INSERT INTO conversations') ? none() : base(sql)));
    expect(await createPgConversationsStore(fx.pool).createChannel(channel)).toEqual({ ok: false, reason: 'name_taken' });
    expect(fx.log.at(-1)).toBe('ROLLBACK');
  });

  it('성공 → 잠금 SELECT, 멤버 upsert, read-state upsert 후 COMMIT', async () => {
    const fx = fakePool(base);
    expect(await createPgConversationsStore(fx.pool).createChannel(channel)).toEqual({ ok: true });
    expect(fx.log).toEqual([
      'BEGIN',
      'SELECT workspace_id FROM',
      'INSERT INTO conversations',
      'SELECT last_seq::text AS',
      'INSERT INTO conversation_members',
      'INSERT INTO conversation_read_state',
      'COMMIT',
    ]);
    expect(fx.params[4]).toEqual(['c1', 'u1', at, '5']);
    expect(fx.released()).toBe(1);
  });

  it('join: 이미 활성 멤버(upsert 0행)면 read state를 건드리지 않는다', async () => {
    const fx = fakePool((sql) => (sql.startsWith('INSERT INTO conversation_members') ? none() : base(sql)));
    await createPgConversationsStore(fx.pool).join('c1', 'u1', at);
    expect(fx.log).toEqual(['BEGIN', 'SELECT last_seq::text AS', 'INSERT INTO conversation_members', 'COMMIT']);
  });

  it('join: 대화 행이 없으면 멤버 upsert 없이 COMMIT', async () => {
    const fx = fakePool((sql) => (sql.startsWith('SELECT last_seq') ? none() : base(sql)));
    await createPgConversationsStore(fx.pool).join('c1', 'u1', at);
    expect(fx.log).toEqual(['BEGIN', 'SELECT last_seq::text AS', 'COMMIT']);
  });

  it('트랜잭션 중 오류는 ROLLBACK 후 다시 던지고 연결을 돌려준다', async () => {
    const fx = fakePool((sql) => {
      if (sql.startsWith('INSERT INTO conversations')) throw new Error('db down');
      return base(sql);
    });
    await expect(createPgConversationsStore(fx.pool).createChannel(channel)).rejects.toThrow('db down');
    expect(fx.log.at(-1)).toBe('ROLLBACK');
    expect(fx.released()).toBe(1);
  });
});

describe('createPgConversationsStore: openDm', () => {
  const run = async (respond: Responder) => {
    const fx = fakePool(respond);
    const result = await createPgConversationsStore(fx.pool).openDm(dm);
    return { result, fx };
  };

  it('workspace 없음·비활성 상대 → ROLLBACK ok:false', async () => {
    const noWs = await run((sql) => (sql.startsWith('SELECT workspace_id') ? none() : base(sql)));
    expect(noWs.result).toEqual({ ok: false });
    expect(noWs.fx.log.at(-1)).toBe('ROLLBACK');
    const inactive = await run((sql) => (sql.startsWith('SELECT 1 FROM users') ? none() : base(sql)));
    expect(inactive.result).toEqual({ ok: false });
    expect(inactive.fx.log.at(-1)).toBe('ROLLBACK');
  });

  it('새로 삽입 → 두 사용자 joinIn 후 COMMIT', async () => {
    const { result, fx } = await run(base);
    expect(result).toEqual({ ok: true, id: 'd1' });
    expect(fx.log.filter((l) => l === 'INSERT INTO conversation_members')).toHaveLength(2);
    const memberParams = fx.params.filter((p, i) => fx.log[i] === 'INSERT INTO conversation_members');
    expect(memberParams.map((p) => p[1])).toEqual(['u1', 'u2']);
    expect(fx.log.at(-1)).toBe('COMMIT');
  });

  it('충돌 → pair key로 기존 id 재조회, 재조회 비면 ok:false', async () => {
    const conflict = (rows: unknown[]) => (sql: string) => {
      if (sql.startsWith('INSERT INTO conversations')) return none();
      if (sql.startsWith('SELECT id FROM conversations')) return ok(rows);
      return base(sql);
    };
    const found = await run(conflict([{ id: 'existing' }]));
    expect(found.result).toEqual({ ok: true, id: 'existing' });
    expect(found.fx.log.at(-1)).toBe('COMMIT');
    expect(found.fx.log).not.toContain('INSERT INTO conversation_members');
    const empty = await run(conflict([]));
    expect(empty.result).toEqual({ ok: false });
    expect(empty.fx.log.at(-1)).toBe('ROLLBACK');
  });
});
