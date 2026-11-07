import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPgMessagesStore } from '../../src/modules/messages/index.js';
import { MENTION_FILTER_SQL, MESSAGE_COLUMNS, toRecord } from '../../src/modules/messages/repo.js';
import type { NewMessage } from '../../src/modules/messages/store.js';

/** pg 저장소의 SQL·트랜잭션 제어 흐름만 본다(실DB 원자성·동시성은 int 테스트). 응답은 SQL 내용으로 고른다. */
type Result = { rows: unknown[]; rowCount: number };
type Responder = (sql: string, params: unknown[]) => Result | undefined;

function fakePool(respond: Responder) {
  const log: string[] = [];
  const sqls: string[] = [];
  const params: unknown[][] = [];
  let released = 0;
  const query = async (sql: string, args: unknown[] = []) => {
    log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    sqls.push(sql);
    params.push(args);
    return respond(sql, args) ?? base(sql);
  };
  const pool = { query, connect: async () => ({ query, release: () => (released += 1) }) } as unknown as pg.Pool;
  return { pool, log, sqls, params, released: () => released };
}

const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
const none = () => ok([]);
const at = new Date(0);
const U1 = 'u1';
const U2 = 'u2';
const U3 = 'u3';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    conversation_id: 'c1',
    seq: '6',
    author_id: U1,
    client_message_id: 'k1',
    thread_root_id: null,
    body: 'hi',
    created_at: at,
    edited_at: null,
    deleted_at: null,
    mention_user_ids: [U2],
    root_reply_count: '0',
    ...over,
  };
}

const isLoad = (sql: string) => sql.startsWith('SELECT m.id') && !sql.includes('ORDER BY m.seq');

/** 기본 응답: 대화 있음, 기존 메시지 없음, 활성 멤버, 원문 정상, mention U2 통과, 저장 후 재조회 성공. */
function base(sql: string): Result {
  if (sql.startsWith('SELECT id FROM conversations')) return ok([{ id: 'c1' }]);
  if (sql.startsWith('SELECT id FROM messages')) return none();
  if (sql.startsWith('SELECT 1 FROM conversation_members')) return ok([{}]);
  if (sql.startsWith('SELECT thread_root_id, deleted_at')) return ok([{ thread_root_id: null, deleted_at: null }]);
  if (sql === MENTION_FILTER_SQL) return ok([{ id: U2 }]);
  if (sql.startsWith('UPDATE conversations SET last_seq')) return ok([{ seq: '6' }]);
  if (sql.startsWith('UPDATE sync_clock')) return ok([{ id: '9' }]);
  if (sql.startsWith('SELECT change_id')) return ok([{ id: '4' }]);
  if (sql.includes('FOR NO KEY UPDATE')) return ok([{ conversation_id: 'c1', author_id: U1, thread_root_id: null, deleted_at: null }]);
  if (sql.startsWith('SELECT user_id FROM message_mentions')) return ok([{ user_id: U2 }]);
  if (isLoad(sql)) return ok([row()]);
  return none();
}

const msg = (over: Partial<NewMessage> = {}): NewMessage => ({
  id: 'm1',
  conversationId: 'c1',
  authorId: U1,
  clientMessageId: 'k1',
  threadRootId: null,
  body: 'hi',
  mentionUserIds: [U2, U2],
  at,
  ...over,
});

const existing = (sql: string) => (sql.startsWith('SELECT id FROM messages') ? ok([{ id: 'm1' }]) : undefined);

describe('repo 매핑·상수', () => {
  it('toRecord: bigint 문자열 → number, 답글은 rootReplyCount null', () => {
    expect(toRecord(row({ seq: '12', root_reply_count: '3' }))).toMatchObject({ seq: 12, rootReplyCount: 3, mentionUserIds: [U2] });
    expect(toRecord(row({ thread_root_id: 'r', root_reply_count: null })).rootReplyCount).toBeNull();
  });

  it('MESSAGE_COLUMNS·MENTION_FILTER_SQL은 삭제 답글 제외·활성 참여자·작성자 제외를 담는다', () => {
    expect(MESSAGE_COLUMNS).toContain('r.deleted_at IS NULL');
    expect(MENTION_FILTER_SQL).toContain('cm.left_at IS NULL');
    expect(MENTION_FILTER_SQL).toContain('u.id <> $3');
  });
});

describe('createPgMessagesStore: send', () => {
  it('created: 잠금 → 멱등 조회 → 멤버 → mention → seq → INSERT → mention·스레드 대상 → change → 재조회 → COMMIT', async () => {
    const fx = fakePool(() => undefined);
    const result = await createPgMessagesStore(fx.pool).send(msg());
    expect(result).toMatchObject({ kind: 'created', changeId: 9, message: { id: 'm1', seq: 6, mentionUserIds: [U2] } });
    expect(fx.log).toEqual([
      'BEGIN',
      'SELECT id FROM',
      'SELECT id FROM',
      'SELECT 1 FROM',
      'SELECT u.id FROM',
      'UPDATE conversations SET',
      'INSERT INTO messages',
      'INSERT INTO message_mentions',
      'INSERT INTO thread_unread_targets',
      'UPDATE sync_clock SET',
      'INSERT INTO conversation_changes',
      'SELECT m.id, m.conversation_id,',
      'COMMIT',
    ]);
    expect(fx.params[4]).toEqual(['c1', [U2], U1]);
    expect(fx.params[6]?.[2]).toBe('6');
    expect(fx.params[8]).toEqual(['m1', [U1, U2], at]);
    expect(fx.params[10]).toEqual([9, 'c1', 'm1', 'create', at]);
    expect(fx.released()).toBe(1);
  });

  it('답글 + mention 없음: 원문 검증, mention 쿼리·INSERT 생략, 스레드 대상 루트는 원문', async () => {
    const fx = fakePool(() => undefined);
    await createPgMessagesStore(fx.pool).send(msg({ threadRootId: 'r1', mentionUserIds: [] }));
    expect(fx.log).toContain('SELECT thread_root_id, deleted_at');
    expect(fx.log).not.toContain('SELECT u.id FROM');
    expect(fx.log).not.toContain('INSERT INTO message_mentions');
    const targets = fx.params[fx.log.indexOf('INSERT INTO thread_unread_targets')];
    expect(targets).toEqual(['r1', [U1], at]);
  });

  it('replayed: 같은 payload면 원래 메시지와 원래 change_id, ROLLBACK(쓰기 없음)', async () => {
    const fx = fakePool(existing);
    expect(await createPgMessagesStore(fx.pool).send(msg())).toMatchObject({ kind: 'replayed', changeId: 4, message: { id: 'm1' } });
    expect(fx.log.at(-1)).toBe('ROLLBACK');
    expect(fx.log.some((l) => l.startsWith('INSERT') || l.startsWith('UPDATE'))).toBe(false);
    expect(fx.released()).toBe(1);
  });

  it('conflict: 본문·원문·mention 집합이 다르거나 원본 재조회가 비면 충돌', async () => {
    const send = async (over: Partial<NewMessage>, extra: Responder = () => undefined) => {
      const fx = fakePool((sql, p) => existing(sql) ?? extra(sql, p));
      const result = await createPgMessagesStore(fx.pool).send(msg(over));
      expect(fx.log.at(-1)).toBe('ROLLBACK');
      return result;
    };
    expect(await send({ body: 'other' })).toEqual({ kind: 'conflict' });
    expect(await send({ threadRootId: 'r1' })).toEqual({ kind: 'conflict' });
    // 저장 mention(U2)이 요청에 없으면 충돌.
    expect(await send({ mentionUserIds: [] })).toEqual({ kind: 'conflict' });
    // 요청에만 있는 U3가 생성 시점에 이미 활성 참여자였으면 충돌, 아니었으면(나중에 참여) 같은 요청.
    const eligible = (rows: unknown[]) => (sql: string) => (sql.trim().startsWith('SELECT 1 FROM conversation_members cm') ? ok(rows) : undefined);
    expect(await send({ mentionUserIds: [U2, U3] }, eligible([{}]))).toEqual({ kind: 'conflict' });
    expect(await send({ mentionUserIds: [U2, U3] }, eligible([]))).toMatchObject({ kind: 'replayed' });
    expect(await send({}, (sql) => (isLoad(sql) ? none() : undefined))).toEqual({ kind: 'conflict' });
  });

  it('not_member: 대화 행 없음 또는 비활성 멤버 → ROLLBACK', async () => {
    const noConv = fakePool((sql) => (sql.startsWith('SELECT id FROM conversations') ? none() : undefined));
    expect(await createPgMessagesStore(noConv.pool).send(msg())).toEqual({ kind: 'not_member' });
    expect(noConv.log).toEqual(['BEGIN', 'SELECT id FROM', 'ROLLBACK']);
    const left = fakePool((sql) => (sql.startsWith('SELECT 1 FROM conversation_members') ? none() : undefined));
    expect(await createPgMessagesStore(left.pool).send(msg())).toEqual({ kind: 'not_member' });
    expect(left.log.at(-1)).toBe('ROLLBACK');
    const nullCount = fakePool((sql) => (sql.startsWith('SELECT id FROM conversations') ? { rows: [], rowCount: null as unknown as number } : undefined));
    expect(await createPgMessagesStore(nullCount.pool).send(msg())).toEqual({ kind: 'not_member' });
  });

  it('bad_root: 원문 없음·답글을 원문으로·삭제된 원문 → ROLLBACK', async () => {
    for (const rootRows of [[], [{ thread_root_id: 'x', deleted_at: null }], [{ thread_root_id: null, deleted_at: at }]]) {
      const fx = fakePool((sql) => (sql.startsWith('SELECT thread_root_id, deleted_at') ? ok(rootRows) : undefined));
      expect(await createPgMessagesStore(fx.pool).send(msg({ threadRootId: 'r1' }))).toEqual({ kind: 'bad_root' });
      expect(fx.params[fx.log.indexOf('SELECT thread_root_id, deleted_at')]).toEqual(['c1', 'r1']);
      expect(fx.log.at(-1)).toBe('ROLLBACK');
    }
  });

  it('오류(재조회 실패 포함)는 ROLLBACK 후 다시 던지고 연결을 돌려준다', async () => {
    const fx = fakePool((sql) => (isLoad(sql) ? none() : undefined));
    await expect(createPgMessagesStore(fx.pool).send(msg())).rejects.toThrow('다시 읽지 못했습니다');
    expect(fx.log.at(-1)).toBe('ROLLBACK');
    expect(fx.log).not.toContain('COMMIT');
    expect(fx.released()).toBe(1);
  });

  it('ROLLBACK 자체가 실패해도 원래 오류를 던진다', async () => {
    const fx = fakePool((sql) => {
      if (sql.startsWith('INSERT INTO messages')) throw new Error('db down');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return undefined;
    });
    await expect(createPgMessagesStore(fx.pool).send(msg())).rejects.toThrow('db down');
    expect(fx.released()).toBe(1);
  });
});

const edit = { id: 'm1', editorId: U1, body: 'new', mentionUserIds: [U2, U3], at };

describe('createPgMessagesStore: edit·remove', () => {
  it('edit ok: 새로 추가된 mention만 스레드 대상, change op=edit, COMMIT', async () => {
    const fx = fakePool((sql) => (sql === MENTION_FILTER_SQL ? ok([{ id: U2 }, { id: U3 }]) : undefined));
    expect(await createPgMessagesStore(fx.pool).edit(edit)).toMatchObject({ kind: 'ok', changeId: 9, message: { id: 'm1' } });
    expect(fx.log).toEqual([
      'BEGIN',
      'SELECT conversation_id, author_id,',
      'SELECT 1 FROM',
      'SELECT u.id FROM',
      'SELECT user_id FROM',
      'UPDATE messages SET',
      'DELETE FROM message_mentions',
      'INSERT INTO message_mentions',
      'INSERT INTO thread_unread_targets',
      'UPDATE sync_clock SET',
      'INSERT INTO conversation_changes',
      'SELECT m.id, m.conversation_id,',
      'COMMIT',
    ]);
    expect(fx.params[5]).toEqual(['m1', 'new', at]);
    expect(fx.params[6]).toEqual(['m1', [U2, U3]]);
    expect(fx.params[8]).toEqual(['m1', [U3], at]);
    expect(fx.params[10]?.[3]).toBe('edit');
    expect(fx.released()).toBe(1);
  });

  it('edit: mention이 모두 기존이면 스레드 대상 INSERT 없음, 답글이면 원문 기준', async () => {
    const fx = fakePool((sql) =>
      sql.includes('FOR NO KEY UPDATE') ? ok([{ conversation_id: 'c1', author_id: U1, thread_root_id: 'r1', deleted_at: null }]) : undefined,
    );
    await createPgMessagesStore(fx.pool).edit({ ...edit, mentionUserIds: [U2] });
    expect(fx.log).not.toContain('INSERT INTO thread_unread_targets');
    const withNew = fakePool((sql) => {
      if (sql.includes('FOR NO KEY UPDATE')) return ok([{ conversation_id: 'c1', author_id: U1, thread_root_id: 'r1', deleted_at: null }]);
      if (sql.startsWith('SELECT user_id FROM message_mentions')) return none();
      return undefined;
    });
    await createPgMessagesStore(withNew.pool).edit({ ...edit, mentionUserIds: [U2] });
    expect(withNew.params[withNew.log.indexOf('INSERT INTO thread_unread_targets')]).toEqual(['r1', [U2], at]);
  });

  it('edit: 없음·삭제됨·비멤버 → not_found, 남의 메시지 → forbidden, 모두 ROLLBACK', async () => {
    const lock = (rows: unknown[], member = true) =>
      fakePool((sql) => {
        if (sql.includes('FOR NO KEY UPDATE')) return ok(rows);
        if (sql.startsWith('SELECT 1 FROM conversation_members') && !member) return none();
        return undefined;
      });
    const own = { conversation_id: 'c1', author_id: U1, thread_root_id: null, deleted_at: null };
    const cases: [ReturnType<typeof lock>, string][] = [
      [lock([]), 'not_found'],
      [lock([{ ...own, deleted_at: at }]), 'not_found'],
      [lock([own], false), 'not_found'],
      [lock([{ ...own, author_id: U2 }]), 'forbidden'],
    ];
    for (const [fx, kind] of cases) {
      expect(await createPgMessagesStore(fx.pool).edit(edit)).toEqual({ kind });
      expect(fx.log.at(-1)).toBe('ROLLBACK');
      expect(fx.log.some((l) => l.startsWith('UPDATE'))).toBe(false);
      expect(fx.released()).toBe(1);
    }
  });

  it('edit 재조회 실패 → ROLLBACK + throw', async () => {
    const fx = fakePool((sql) => (isLoad(sql) ? none() : undefined));
    await expect(createPgMessagesStore(fx.pool).edit(edit)).rejects.toThrow('다시 읽지 못했습니다');
    expect(fx.log.at(-1)).toBe('ROLLBACK');
  });

  it('remove ok: 본문 NULL·deleted_at, mention 삭제, change op=delete, COMMIT', async () => {
    const fx = fakePool((sql) => (isLoad(sql) ? ok([row({ body: null, deleted_at: at, mention_user_ids: [] })]) : undefined));
    const result = await createPgMessagesStore(fx.pool).remove('m1', U1, at);
    expect(result).toMatchObject({ kind: 'ok', changeId: 9, message: { body: null, deletedAt: at, mentionUserIds: [] } });
    expect(fx.log).toEqual([
      'BEGIN',
      'SELECT conversation_id, author_id,',
      'SELECT 1 FROM',
      'UPDATE messages SET',
      'DELETE FROM message_mentions',
      'UPDATE sync_clock SET',
      'INSERT INTO conversation_changes',
      'SELECT m.id, m.conversation_id,',
      'COMMIT',
    ]);
    expect(fx.params[3]).toEqual(['m1', at]);
    expect(fx.params[6]?.[3]).toBe('delete');
  });

  it('remove: forbidden·재조회 실패', async () => {
    const other = fakePool((sql) =>
      sql.includes('FOR NO KEY UPDATE') ? ok([{ conversation_id: 'c1', author_id: U2, thread_root_id: null, deleted_at: null }]) : undefined,
    );
    expect(await createPgMessagesStore(other.pool).remove('m1', U1, at)).toEqual({ kind: 'forbidden' });
    expect(other.log.at(-1)).toBe('ROLLBACK');
    const lost = fakePool((sql) => (isLoad(sql) ? none() : undefined));
    await expect(createPgMessagesStore(lost.pool).remove('m1', U1, at)).rejects.toThrow('다시 읽지 못했습니다');
    expect(lost.log.at(-1)).toBe('ROLLBACK');
  });
});

/** seq 목록에서 LIMIT($3) 만큼 정렬 방향대로 돌려주는 페이지 응답. */
function pages(seqs: number[]) {
  return fakePool((sql, p) => {
    if (!sql.includes('ORDER BY m.seq')) return undefined;
    const pivot = p[1] as number | null;
    const limit = p[2] as number;
    const desc = sql.includes('DESC');
    let hit = seqs.filter((s) => {
      if (sql.includes('m.seq > $2')) return s > (pivot ?? 0);
      if (sql.includes('m.seq >= $2')) return s >= (pivot ?? 0);
      return pivot === null || s < pivot;
    });
    hit = desc ? hit.sort((a, b) => b - a) : hit.sort((a, b) => a - b);
    return ok(hit.slice(0, limit).map((s) => row({ id: `m${s}`, seq: String(s) })));
  });
}

const seqsOf = (page: { messages: readonly { seq: number }[] }) => page.messages.map((m) => m.seq);

describe('createPgMessagesStore: 조회', () => {
  it('history latest: before 없음은 null, DESC로 읽어 오름차순 반환, has_more', async () => {
    const fx = pages([1, 2, 3, 4, 5]);
    const store = createPgMessagesStore(fx.pool);
    const latest = await store.history('c1', { limit: 2 });
    expect(seqsOf(latest)).toEqual([4, 5]);
    expect(latest.hasMore).toBe(true);
    expect(fx.params[0]).toEqual(['c1', null, 3]);
    expect(fx.sqls[0]).toContain('m.thread_root_id IS NULL');
    const all = await store.history('c1', { limit: 10 });
    expect(seqsOf(all)).toEqual([1, 2, 3, 4, 5]);
    expect(all.hasMore).toBe(false);
  });

  it('history before·after', async () => {
    const fx = pages([1, 2, 3, 4, 5]);
    const store = createPgMessagesStore(fx.pool);
    const before = await store.history('c1', { beforeSeq: 4, limit: 2 });
    expect(seqsOf(before)).toEqual([2, 3]);
    expect(before.hasMore).toBe(true);
    expect(fx.params[0]).toEqual(['c1', 4, 3]);
    const after = await store.history('c1', { afterSeq: 2, limit: 2 });
    expect(seqsOf(after)).toEqual([3, 4]);
    expect(after.hasMore).toBe(true);
    expect(fx.sqls[1]).toContain('ORDER BY m.seq ASC');
    const tail = await store.history('c1', { afterSeq: 3, limit: 5 });
    expect(seqsOf(tail)).toEqual([4, 5]);
    expect(tail.hasMore).toBe(false);
  });

  it('history around: 앞 절반(DESC) + 기준 포함 뒤 절반(ASC), 어느 쪽이든 넘치면 has_more', async () => {
    const fx = pages([1, 2, 3, 4, 5, 6, 7]);
    const store = createPgMessagesStore(fx.pool);
    const mid = await store.history('c1', { aroundSeq: 4, limit: 4 });
    expect(seqsOf(mid)).toEqual([2, 3, 4, 5]);
    expect(mid.hasMore).toBe(true);
    expect(fx.params.slice(0, 2)).toEqual([
      ['c1', 4, 3],
      ['c1', 4, 3],
    ]);
    const wide = await store.history('c1', { aroundSeq: 4, limit: 20 });
    expect(seqsOf(wide)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(wide.hasMore).toBe(false);
    const edge = await store.history('c1', { aroundSeq: 7, limit: 4 });
    expect(seqsOf(edge)).toEqual([5, 6, 7]);
    expect(edge.hasMore).toBe(true);
  });

  it('replies: 원문 기준 scope, get·locate 매핑', async () => {
    const fx = pages([2, 3]);
    const store = createPgMessagesStore(fx.pool);
    const replies = await store.replies('r1', { limit: 5 });
    expect(seqsOf(replies)).toEqual([2, 3]);
    expect(fx.sqls[0]).toContain('m.thread_root_id = $1');
    expect(fx.params[0]?.[0]).toBe('r1');

    const hit = fakePool((sql) =>
      sql.startsWith('SELECT conversation_id, author_id') ? ok([{ conversation_id: 'c1', author_id: U1, thread_root_id: 'r1' }]) : undefined,
    );
    expect(await createPgMessagesStore(hit.pool).locate('m1')).toEqual({ conversationId: 'c1', authorId: U1, threadRootId: 'r1' });
    const miss = fakePool((sql) => (sql.startsWith('SELECT conversation_id') ? none() : undefined));
    expect(await createPgMessagesStore(miss.pool).locate('m1')).toBeUndefined();

    const got = fakePool(() => undefined);
    expect(await createPgMessagesStore(got.pool).get('m1')).toMatchObject({ id: 'm1', seq: 6 });
    expect(got.params[0]).toEqual(['m1']);
    const gone = fakePool((sql) => (isLoad(sql) ? none() : undefined));
    expect(await createPgMessagesStore(gone.pool).get('m1')).toBeUndefined();
  });
});
