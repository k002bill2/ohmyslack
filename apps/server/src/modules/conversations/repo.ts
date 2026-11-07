import type pg from 'pg';
import type {
  ConversationKind,
  ConversationRow,
  ConversationsStore,
  CreateChannelResult,
  OpenDmResult,
  UnreadThread,
} from './store.js';

interface UnreadThreadRow {
  root_message_id: string;
  last_read_seq: number | string;
  last_reply_seq: number | string;
  unread_reply_count: number | string;
  mention_count: number | string;
}

/** conversations 저장소의 pg 구현. 모든 SQL은 파라미터 바인딩만 쓴다(NC-25). */

/** 접근 판정 SQL(assertAccess 단일 입력). 현재 멤버십은 `left_at IS NULL`만 인정한다(TRD §2). */
export const ACCESS_SQL = `SELECT c.kind,
    EXISTS (SELECT 1 FROM conversation_members m
             WHERE m.conversation_id = c.id AND m.user_id = $2 AND m.left_at IS NULL) AS active_member
  FROM conversations c WHERE c.id = $1`;

const WORKSPACE_OF_SQL = 'SELECT workspace_id FROM workspace_members WHERE user_id = $1';

const ACTIVE_PEER_SQL = `SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id = u.id
  WHERE u.id = $1 AND u.status = 'active' AND wm.workspace_id = $2`;

/** 이미 활성 멤버면 갱신하지 않는다(RETURNING 0행). 나간 멤버는 재참여로 joined_seq·joined_at을 새로 쓴다. */
const UPSERT_MEMBER_SQL = `INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq, left_at)
  VALUES ($1, $2, $3, $4, NULL)
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET joined_at = EXCLUDED.joined_at, joined_seq = EXCLUDED.joined_seq, left_at = NULL
    WHERE conversation_members.left_at IS NOT NULL
  RETURNING user_id`;

/** 읽음 위치는 뒤로 가지 않는다(TRD §2 단조 병합). */
const UPSERT_READ_STATE_SQL = `INSERT INTO conversation_read_state (conversation_id, user_id, last_read_seq, updated_at)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET last_read_seq = GREATEST(conversation_read_state.last_read_seq, EXCLUDED.last_read_seq), updated_at = EXCLUDED.updated_at`;

/**
 * 목록 + 집계를 **한 문장**으로(대화 수에 비례한 추가 쿼리 금지, TRD §3:99). 자기 메시지·삭제 tombstone은 unread·mention에서 뺀다.
 * - unread_count: 본문 cursor 뒤의 top-level 원문만.
 * - 스레드 cursor: thread_read_state가 없으면 joined_seq(TRD §2). 이전 멤버십의 낮은 값도 joined_seq 아래로 내려가지 않는다.
 * - unread_threads: thread_unread_targets 대상 중 읽지 않은 답글이 있는 root만.
 * - mention_count: 미열람 원문(본문 cursor)·답글(스레드 cursor)의 본인 대상 mention.
 */
const LIST_FOR_USER_SQL = `SELECT c.id, c.kind, c.name, c.last_seq::text AS last_seq, rd.seq::text AS last_read_seq,
    (SELECT o.user_id FROM conversation_members o
      WHERE c.kind = 'dm' AND o.conversation_id = c.id AND o.user_id <> $1 LIMIT 1) AS peer_user_id,
    (SELECT count(*) FROM messages x
      WHERE x.conversation_id = c.id AND x.thread_root_id IS NULL AND x.seq > rd.seq
        AND x.author_id <> $1 AND x.deleted_at IS NULL)::text AS unread_count,
    (SELECT count(*) FROM message_mentions mm JOIN messages x ON x.id = mm.message_id
      WHERE mm.user_id = $1 AND x.conversation_id = c.id AND x.author_id <> $1 AND x.deleted_at IS NULL
        AND x.seq > CASE WHEN x.thread_root_id IS NULL THEN rd.seq ELSE GREATEST(m.joined_seq,
          COALESCE((SELECT t.last_read_seq FROM thread_read_state t WHERE t.root_message_id = x.thread_root_id AND t.user_id = $1), 0)) END
    )::text AS mention_count,
    (SELECT COALESCE(json_agg(json_build_object(
        'root_message_id', s.root_message_id, 'last_read_seq', s.read_seq, 'last_reply_seq', s.last_reply_seq,
        'unread_reply_count', s.unread_reply_count, 'mention_count', s.mention_count) ORDER BY s.root_seq), '[]'::json)
      FROM (
        SELECT q.root_message_id, root.seq AS root_seq, tr.read_seq,
          (SELECT COALESCE(max(x.seq), 0) FROM messages x
            WHERE x.conversation_id = c.id AND x.thread_root_id = q.root_message_id AND x.deleted_at IS NULL) AS last_reply_seq,
          (SELECT count(*) FROM messages x
            WHERE x.conversation_id = c.id AND x.thread_root_id = q.root_message_id AND x.seq > tr.read_seq
              AND x.author_id <> $1 AND x.deleted_at IS NULL) AS unread_reply_count,
          (SELECT count(*) FROM messages x JOIN message_mentions mm ON mm.message_id = x.id AND mm.user_id = $1
            WHERE x.conversation_id = c.id AND x.thread_root_id = q.root_message_id AND x.seq > tr.read_seq
              AND x.author_id <> $1 AND x.deleted_at IS NULL) AS mention_count
        FROM thread_unread_targets q
        JOIN messages root ON root.id = q.root_message_id AND root.conversation_id = c.id
        LEFT JOIN thread_read_state trs ON trs.root_message_id = q.root_message_id AND trs.user_id = $1
        CROSS JOIN LATERAL (SELECT GREATEST(m.joined_seq, COALESCE(trs.last_read_seq, 0)) AS read_seq) tr
        WHERE q.user_id = $1
      ) s WHERE s.unread_reply_count > 0) AS unread_threads
  FROM conversation_members m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN conversation_read_state r ON r.conversation_id = c.id AND r.user_id = m.user_id
  CROSS JOIN LATERAL (SELECT COALESCE(r.last_read_seq, m.joined_seq) AS seq) rd
  WHERE m.user_id = $1 AND m.left_at IS NULL AND ($2::uuid IS NULL OR c.id > $2::uuid)
  ORDER BY c.id LIMIT $3`;

const DISCOVER_SQL = `SELECT c.id, c.name FROM conversations c
  WHERE c.kind = 'channel'
    AND c.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
    AND ($2::uuid IS NULL OR c.id > $2::uuid)
    AND NOT EXISTS (SELECT 1 FROM conversation_members m
                     WHERE m.conversation_id = c.id AND m.user_id = $1 AND m.left_at IS NULL)
  ORDER BY c.id LIMIT $3`;

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

/** 멤버십 생성·재참여: 대화 행을 잠가 last_seq를 읽고 joined_seq·read cursor를 그 값으로 둔다(TRD §2). */
async function joinIn(client: pg.PoolClient, conversationId: string, userId: string, at: Date): Promise<void> {
  const conv = await client.query<{ last_seq: string }>('SELECT last_seq::text AS last_seq FROM conversations WHERE id = $1 FOR UPDATE', [
    conversationId,
  ]);
  const lastSeq = conv.rows[0]?.last_seq;
  if (lastSeq === undefined) return;
  const member = await client.query(UPSERT_MEMBER_SQL, [conversationId, userId, at, lastSeq]);
  if ((member.rowCount ?? 0) > 0) await client.query(UPSERT_READ_STATE_SQL, [conversationId, userId, lastSeq, at]);
}

async function workspaceOf(client: pg.PoolClient, userId: string): Promise<string | undefined> {
  const res = await client.query<{ workspace_id: string }>(WORKSPACE_OF_SQL, [userId]);
  return res.rows[0]?.workspace_id;
}

export function createPgConversationsStore(pool: pg.Pool): ConversationsStore {
  return {
    async findAccess(conversationId, userId) {
      const res = await pool.query<{ kind: ConversationKind; active_member: boolean }>(ACCESS_SQL, [conversationId, userId]);
      const row = res.rows[0];
      return row === undefined ? undefined : { kind: row.kind, activeMember: row.active_member };
    },
    createChannel(channel) {
      return inTransaction<CreateChannelResult>(pool, async (client) => {
        const workspaceId = await workspaceOf(client, channel.creatorId);
        if (workspaceId === undefined) return { commit: false, value: { ok: false, reason: 'no_workspace' } };
        const inserted = await client.query(
          `INSERT INTO conversations (id, workspace_id, kind, name, name_norm, created_at)
           VALUES ($1, $2, 'channel', $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
          [channel.id, workspaceId, channel.name, channel.nameNorm, channel.at],
        );
        if ((inserted.rowCount ?? 0) === 0) return { commit: false, value: { ok: false, reason: 'name_taken' } };
        await joinIn(client, channel.id, channel.creatorId, channel.at);
        return { commit: true, value: { ok: true } };
      });
    },
    async discover(userId, after, limit) {
      const res = await pool.query<{ id: string; name: string }>(DISCOVER_SQL, [userId, after ?? null, limit]);
      return res.rows.map((r) => ({ id: r.id, name: r.name }));
    },
    join(conversationId, userId, at) {
      return inTransaction<void>(pool, async (client) => {
        await joinIn(client, conversationId, userId, at);
        return { commit: true, value: undefined };
      });
    },
    async leave(conversationId, userId, at) {
      const res = await pool.query(
        'UPDATE conversation_members SET left_at = $3 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
        [conversationId, userId, at],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async listMembers(conversationId) {
      const res = await pool.query<{ id: string; display_name: string }>(
        `SELECT u.id, u.display_name FROM conversation_members m JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = $1 AND m.left_at IS NULL AND u.status = 'active' ORDER BY u.display_name, u.id`,
        [conversationId],
      );
      return res.rows.map((r) => ({ id: r.id, displayName: r.display_name }));
    },
    async listForUser(userId, after, limit) {
      const res = await pool.query<{
        id: string;
        kind: ConversationKind;
        name: string | null;
        last_seq: string;
        last_read_seq: string;
        peer_user_id: string | null;
        unread_count: string;
        mention_count: string;
        unread_threads: UnreadThreadRow[];
      }>(LIST_FOR_USER_SQL, [userId, after ?? null, limit]);
      return res.rows.map(
        (r): ConversationRow => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          peerUserId: r.peer_user_id,
          lastSeq: Number(r.last_seq),
          lastReadSeq: Number(r.last_read_seq),
          unreadCount: Number(r.unread_count),
          mentionCount: Number(r.mention_count),
          unreadThreads: r.unread_threads.map(
            (t): UnreadThread => ({
              rootMessageId: t.root_message_id,
              lastReadSeq: Number(t.last_read_seq),
              lastReplySeq: Number(t.last_reply_seq),
              unreadReplyCount: Number(t.unread_reply_count),
              mentionCount: Number(t.mention_count),
            }),
          ),
        }),
      );
    },
    openDm(dm) {
      const rejected = { commit: false, value: { ok: false } } as const;
      return inTransaction<OpenDmResult>(pool, async (client) => {
        const workspaceId = await workspaceOf(client, dm.userId);
        if (workspaceId === undefined) return rejected;
        const peer = await client.query(ACTIVE_PEER_SQL, [dm.peerId, workspaceId]);
        if ((peer.rowCount ?? 0) === 0) return rejected;
        // 동시 요청: 같은 키의 진행 중 INSERT를 기다린 뒤 DO NOTHING → 새 문장 스냅숏으로 재조회한다.
        const inserted = await client.query(
          `INSERT INTO conversations (id, workspace_id, kind, normalized_pair_key, created_at)
           VALUES ($1, $2, 'dm', $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
          [dm.id, workspaceId, dm.pairKey, dm.at],
        );
        if ((inserted.rowCount ?? 0) > 0) {
          await joinIn(client, dm.id, dm.userId, dm.at);
          await joinIn(client, dm.id, dm.peerId, dm.at);
          return { commit: true, value: { ok: true, id: dm.id } };
        }
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM conversations WHERE kind = 'dm' AND normalized_pair_key = $1",
          [dm.pairKey],
        );
        const id = existing.rows[0]?.id;
        return id === undefined ? rejected : { commit: true, value: { ok: true, id } };
      });
    },
  };
}
