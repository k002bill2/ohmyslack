import type pg from 'pg';
import type {
  MessageEdit,
  MessageLocator,
  MessageRecord,
  MessagesStore,
  NewMessage,
  Page,
  PageRequest,
  SendResult,
  WriteResult,
} from './store.js';

/**
 * messages 저장소의 pg 구현(TRD §2). 모든 SQL은 파라미터 바인딩만 쓴다(NC-25).
 * 잠금 순서: conversations 행(전송) → messages 행(수정·삭제) → sync_clock 행(마지막). 이 순서로 교착을 피하고,
 * sync_clock 행 잠금이 commit까지 유지되므로 change_id 순서가 commit 순서와 같다.
 */
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** 현재 상태 projection. mention은 삭제 시 행이 지워지므로 tombstone은 자연히 빈 배열이다. */
export const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.seq::text AS seq, m.author_id, m.client_message_id, m.thread_root_id, m.body,
  m.created_at, m.edited_at, m.deleted_at,
  COALESCE((SELECT array_agg(mm.user_id::text ORDER BY mm.user_id) FROM message_mentions mm WHERE mm.message_id = m.id), '{}'::text[])
    AS mention_user_ids,
  (CASE WHEN m.thread_root_id IS NULL THEN (SELECT count(*) FROM messages r
     WHERE r.conversation_id = m.conversation_id AND r.thread_root_id = m.id AND r.deleted_at IS NULL) END)::text AS root_reply_count`;

/** mention 대상: 요청 ID 중 현재 활성 참여자이며 작성자 본인이 아닌 사용자(중복 제거·정렬). */
export const MENTION_FILTER_SQL = `SELECT u.id FROM conversation_members cm JOIN users u ON u.id = cm.user_id
  WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND u.status = 'active' AND u.id = ANY($2::uuid[]) AND u.id <> $3
  ORDER BY u.id`;

const ACTIVE_MEMBER_SQL = 'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL';

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: string;
  author_id: string;
  client_message_id: string;
  thread_root_id: string | null;
  body: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  mention_user_ids: string[];
  root_reply_count: string | null;
}

export function toRecord(r: MessageRow): MessageRecord {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    authorId: r.author_id,
    clientMessageId: r.client_message_id,
    threadRootId: r.thread_root_id,
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    mentionUserIds: r.mention_user_ids,
    rootReplyCount: r.root_reply_count === null ? null : Number(r.root_reply_count),
  };
}

async function load(db: Queryable, id: string): Promise<MessageRecord | undefined> {
  const res = await db.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = $1`, [id]);
  const row = res.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

interface TxOutcome<T> {
  readonly commit: boolean;
  readonly value: T;
}

/** 트랜잭션 안에서는 받은 client만 쓴다(풀 고갈 시 교착 방지). */
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

async function filterMentions(db: Queryable, conversationId: string, ids: readonly string[], authorId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await db.query<{ id: string }>(MENTION_FILTER_SQL, [conversationId, [...new Set(ids)], authorId]);
  return res.rows.map((r) => r.id);
}

async function isActiveMember(db: Queryable, conversationId: string, userId: string): Promise<boolean> {
  return ((await db.query(ACTIVE_MEMBER_SQL, [conversationId, userId])).rowCount ?? 0) > 0;
}

/** 전역 커서 할당 + 변경 기록. 항상 트랜잭션의 마지막 쓰기여야 한다(sync_clock 잠금 시간 최소화). */
async function recordChange(db: Queryable, conversationId: string, messageId: string, op: string, at: Date): Promise<number> {
  const clock = await db.query<{ id: string }>('UPDATE sync_clock SET last_change_id = last_change_id + 1 WHERE id = 1 RETURNING last_change_id::text AS id');
  const changeId = Number(clock.rows[0]?.id);
  await db.query('INSERT INTO conversation_changes (change_id, conversation_id, message_id, op, created_at) VALUES ($1, $2, $3, $4, $5)', [
    changeId,
    conversationId,
    messageId,
    op,
    at,
  ]);
  return changeId;
}

/** 스레드 대상 자격(TRD §2): 원문·답글 작성자와 mention 받은 사용자. 이미 있으면 유지한다. */
async function qualifyThreadTargets(db: Queryable, rootId: string, userIds: readonly string[], at: Date): Promise<void> {
  if (userIds.length === 0) return;
  await db.query(
    `INSERT INTO thread_unread_targets (root_message_id, user_id, qualified_at)
     SELECT $1, u, $3 FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING`,
    [rootId, [...userIds], at],
  );
}

async function insertMentions(db: Queryable, messageId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.query('INSERT INTO message_mentions (message_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING', [
    messageId,
    [...userIds],
  ]);
}

/**
 * 재시도 mention 비교. 저장 행은 생성 시점 필터 결과이므로 요청 원본과 직접 비교하지 않는다:
 * 저장 행 ⊆ 요청 집합이고, 요청에만 있는 ID 중 생성 시점에 이미 활성 참여자였던 사람이 없으면 같은 요청이다
 * (생성 뒤 나간 사람·새로 들어온 사람 때문에 같은 재시도가 409가 되지 않는다).
 */
async function sameMentions(client: pg.PoolClient, original: MessageRecord, requested: readonly string[]): Promise<boolean> {
  const requestSet = new Set(requested);
  if (!original.mentionUserIds.every((id) => requestSet.has(id))) return false;
  const extra = [...requestSet].filter((id) => !original.mentionUserIds.includes(id));
  if (extra.length === 0) return true;
  const eligible = await client.query(
    `SELECT 1 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND u.status = 'active' AND u.id = ANY($2::uuid[]) AND u.id <> $3
       AND cm.joined_at <= $4`,
    [original.conversationId, extra, original.authorId, original.createdAt],
  );
  return (eligible.rowCount ?? 0) === 0;
}

/**
 * 같은 멱등 키 재시도: 같은 payload(본문·thread_root_id·mention 집합)면 원래 메시지(현재 상태), 아니면 충돌.
 * 수정·삭제된 메시지는 최초 본문·mention을 보존하지 않으므로(스키마 변경 없음) thread_root_id만 비교한다.
 */
async function replay(client: pg.PoolClient, existingId: string, msg: NewMessage): Promise<SendResult> {
  const original = await load(client, existingId);
  if (original === undefined || original.threadRootId !== msg.threadRootId) return { kind: 'conflict' };
  const mutated = original.editedAt !== null || original.deletedAt !== null;
  if (!mutated && (original.body !== msg.body || !(await sameMentions(client, original, msg.mentionUserIds)))) return { kind: 'conflict' };
  const change = await client.query<{ id: string }>("SELECT change_id::text AS id FROM conversation_changes WHERE message_id = $1 AND op = 'create'", [
    existingId,
  ]);
  return { kind: 'replayed', message: original, changeId: Number(change.rows[0]?.id) };
}

async function rootIsValid(client: pg.PoolClient, conversationId: string, rootId: string | null): Promise<boolean> {
  if (rootId === null) return true;
  const res = await client.query<{ thread_root_id: string | null; deleted_at: Date | null }>(
    'SELECT thread_root_id, deleted_at FROM messages WHERE conversation_id = $1 AND id = $2',
    [conversationId, rootId],
  );
  const root = res.rows[0];
  return root !== undefined && root.thread_root_id === null && root.deleted_at === null;
}

async function sendIn(client: pg.PoolClient, msg: NewMessage): Promise<TxOutcome<SendResult>> {
  const locked = await client.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [msg.conversationId]);
  if ((locked.rowCount ?? 0) === 0) return { commit: false, value: { kind: 'not_member' } };
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM messages WHERE conversation_id = $1 AND author_id = $2 AND client_message_id = $3',
    [msg.conversationId, msg.authorId, msg.clientMessageId],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) return { commit: false, value: await replay(client, existingId, msg) };
  if (!(await isActiveMember(client, msg.conversationId, msg.authorId))) return { commit: false, value: { kind: 'not_member' } };
  if (!(await rootIsValid(client, msg.conversationId, msg.threadRootId))) return { commit: false, value: { kind: 'bad_root' } };
  const mentions = await filterMentions(client, msg.conversationId, msg.mentionUserIds, msg.authorId);
  const seq = await client.query<{ seq: string }>('UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq::text AS seq', [
    msg.conversationId,
  ]);
  await client.query(
    `INSERT INTO messages (id, conversation_id, seq, author_id, client_message_id, thread_root_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [msg.id, msg.conversationId, seq.rows[0]?.seq, msg.authorId, msg.clientMessageId, msg.threadRootId, msg.body, msg.at],
  );
  await insertMentions(client, msg.id, mentions);
  await qualifyThreadTargets(client, msg.threadRootId ?? msg.id, [msg.authorId, ...mentions], msg.at);
  const changeId = await recordChange(client, msg.conversationId, msg.id, 'create', msg.at);
  const message = await load(client, msg.id);
  if (message === undefined) throw new Error('생성한 메시지를 다시 읽지 못했습니다');
  return { commit: true, value: { kind: 'created', message, changeId } };
}

interface LockedMessage {
  readonly conversationId: string;
  readonly threadRootId: string | null;
}

/** 수정·삭제 대상 행 잠금 + 작성자·삭제·멤버십 확인. 키를 바꾸지 않으므로 FK의 KEY SHARE와 충돌하지 않는 잠금을 쓴다. */
async function lockOwn(client: pg.PoolClient, id: string, actorId: string): Promise<LockedMessage | 'not_found' | 'forbidden'> {
  const res = await client.query<{ conversation_id: string; author_id: string; thread_root_id: string | null; deleted_at: Date | null }>(
    'SELECT conversation_id, author_id, thread_root_id, deleted_at FROM messages WHERE id = $1 FOR NO KEY UPDATE',
    [id],
  );
  const row = res.rows[0];
  if (row === undefined || row.deleted_at !== null) return 'not_found';
  if (!(await isActiveMember(client, row.conversation_id, actorId))) return 'not_found';
  if (row.author_id !== actorId) return 'forbidden';
  return { conversationId: row.conversation_id, threadRootId: row.thread_root_id };
}

async function editIn(client: pg.PoolClient, edit: MessageEdit): Promise<TxOutcome<WriteResult>> {
  const locked = await lockOwn(client, edit.id, edit.editorId);
  if (typeof locked === 'string') return { commit: false, value: { kind: locked } };
  const mentions = await filterMentions(client, locked.conversationId, edit.mentionUserIds, edit.editorId);
  const prior = await client.query<{ user_id: string }>('SELECT user_id FROM message_mentions WHERE message_id = $1', [edit.id]);
  const priorSet = new Set(prior.rows.map((r) => r.user_id));
  await client.query('UPDATE messages SET body = $2, edited_at = $3 WHERE id = $1', [edit.id, edit.body, edit.at]);
  await client.query('DELETE FROM message_mentions WHERE message_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [edit.id, mentions]);
  await insertMentions(client, edit.id, mentions);
  await qualifyThreadTargets(client, locked.threadRootId ?? edit.id, mentions.filter((u) => !priorSet.has(u)), edit.at);
  const changeId = await recordChange(client, locked.conversationId, edit.id, 'edit', edit.at);
  const message = await load(client, edit.id);
  if (message === undefined) throw new Error('수정한 메시지를 다시 읽지 못했습니다');
  return { commit: true, value: { kind: 'ok', message, changeId } };
}

/** tombstone: 본문 NULL·deleted_at, mention 행 제거, change(op=delete)를 한 트랜잭션으로. 스레드 대상 자격은 유지한다. */
async function removeIn(client: pg.PoolClient, id: string, actorId: string, at: Date): Promise<TxOutcome<WriteResult>> {
  const locked = await lockOwn(client, id, actorId);
  if (typeof locked === 'string') return { commit: false, value: { kind: locked } };
  await client.query('UPDATE messages SET body = NULL, deleted_at = $2 WHERE id = $1', [id, at]);
  await client.query('DELETE FROM message_mentions WHERE message_id = $1', [id]);
  const changeId = await recordChange(client, locked.conversationId, id, 'delete', at);
  const message = await load(client, id);
  if (message === undefined) throw new Error('삭제한 메시지를 다시 읽지 못했습니다');
  return { commit: true, value: { kind: 'ok', message, changeId } };
}

/** seq 범위 페이지. `scope`는 `m.`로 시작하는 WHERE 조각, `$1`은 scope 인자. 결과는 항상 seq 오름차순. */
async function pageOf(db: Queryable, scope: string, arg: string, page: PageRequest): Promise<Page> {
  const select = (cond: string, order: 'ASC' | 'DESC', limit: number, seq: number | null) =>
    db.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE ${scope} AND ${cond} ORDER BY m.seq ${order} LIMIT $3`, [
      arg,
      seq,
      limit + 1,
    ]);
  const side = async (cond: string, order: 'ASC' | 'DESC', limit: number, seq: number | null) => {
    const rows = (await select(cond, order, limit, seq)).rows.map(toRecord);
    const kept = rows.slice(0, limit);
    return { rows: order === 'DESC' ? kept.reverse() : kept, more: rows.length > limit };
  };
  if (page.afterSeq !== undefined) {
    const after = await side('m.seq > $2', 'ASC', page.limit, page.afterSeq);
    return { messages: after.rows, hasMore: after.more };
  }
  if (page.aroundSeq !== undefined) {
    const half = Math.floor(page.limit / 2);
    const before = await side('m.seq < $2', 'DESC', half, page.aroundSeq);
    const from = await side('m.seq >= $2', 'ASC', page.limit - half, page.aroundSeq);
    return { messages: [...before.rows, ...from.rows], hasMore: before.more || from.more };
  }
  const before = await side('($2::bigint IS NULL OR m.seq < $2)', 'DESC', page.limit, page.beforeSeq ?? null);
  return { messages: before.rows, hasMore: before.more };
}

export function createPgMessagesStore(pool: pg.Pool): MessagesStore {
  return {
    async locate(messageId) {
      const res = await pool.query<{ conversation_id: string; author_id: string; thread_root_id: string | null }>(
        'SELECT conversation_id, author_id, thread_root_id FROM messages WHERE id = $1',
        [messageId],
      );
      const row = res.rows[0];
      return row === undefined ? undefined : ({ conversationId: row.conversation_id, authorId: row.author_id, threadRootId: row.thread_root_id } satisfies MessageLocator);
    },
    send: (msg) => inTransaction(pool, (client) => sendIn(client, msg)),
    edit: (edit) => inTransaction(pool, (client) => editIn(client, edit)),
    remove: (id, actorId, at) => inTransaction(pool, (client) => removeIn(client, id, actorId, at)),
    history: (conversationId, page) => pageOf(pool, 'm.conversation_id = $1 AND m.thread_root_id IS NULL', conversationId, page),
    get: (messageId) => load(pool, messageId),
    replies: (rootId, page) =>
      pageOf(pool, 'm.conversation_id = (SELECT conversation_id FROM messages WHERE id = $1) AND m.thread_root_id = $1', rootId, page),
  };
}
