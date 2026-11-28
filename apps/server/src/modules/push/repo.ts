import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** push 구독 저장소(정본: TRD §2 `push_subscriptions`, §6-2). 운영은 pg, 단위 테스트는 가짜 구현을 쓴다. */
export interface NewPushSubscription {
  readonly userId: string;
  readonly sessionId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly keyId: string;
  readonly at: Date;
}

export interface PushTarget {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** 알림 대상 판정에 필요한 대화·원문 사실. */
export interface PushContext {
  /** 봇 멤버가 있는 DM(Jarvis DM). */
  readonly botDm: boolean;
  /** 채널 대화(채널 최상위 봇 게시 → 채널 사람 멤버 전원). */
  readonly channel: boolean;
  /** 답글이면 원문 작성자, 아니면 null. */
  readonly rootAuthorId: string | null;
  /** 답글이면 원문 작성자 종류(봇 원문 스레드 보고 → 대화 사람 멤버 전원), 아니면 null. */
  readonly rootAuthorKind: 'human' | 'bot' | null;
}

export interface PushTargetQuery {
  readonly conversationId: string;
  /** 알림 대상 메시지. 삭제됐으면 대상 0(생성 → 전송 사이 삭제 경쟁). */
  readonly messageId: string;
  readonly threadRootId: string | null;
  readonly seq: number;
  /** true면 대화의 모든 멤버(Jarvis DM 새 원문·채널 최상위 봇 게시), 아니면 userIds만. */
  readonly everyone: boolean;
  readonly userIds: readonly string[];
  /** 자기 메시지는 보내지 않는다. */
  readonly authorId: string;
  readonly keyId: string;
  readonly now: Date;
}

export interface PushStore {
  /** endpoint가 같으면 소유자·세션·키를 교체한다(재등록). 구독 ID를 돌려준다. */
  upsert(sub: NewPushSubscription): Promise<string>;
  /** 본인 구독만 지운다. 지웠으면 true. */
  deleteOwn(id: string, userId: string): Promise<boolean>;
  deleteById(id: string): Promise<void>;
  deleteBySessions(sessionIds: readonly string[]): Promise<void>;
  markSuccess(id: string, at: Date): Promise<void>;
  context(conversationId: string, threadRootId: string | null): Promise<PushContext>;
  /** 메시지가 아직 삭제되지 않았으면 true(전송 직전 재확인용 단건 질의). */
  isLive(messageId: string): Promise<boolean>;
  /**
   * 대상 사용자 중 살아 있는 사람 계정·살아 있는 세션·현재 VAPID 키·대화 멤버이고 아직 이 메시지를 읽지 않은 구독.
   * 읽음 위치는 원문이면 대화 읽음, 답글이면 스레드 읽음이다.
   */
  targets(query: PushTargetQuery): Promise<readonly PushTarget[]>;
}

const TARGETS_SQL = `
  SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id AND u.kind = 'human' AND u.status = 'active'
    JOIN sessions s ON s.id = ps.session_id AND s.revoked_at IS NULL AND s.expires_at > $5
    JOIN conversation_members cm ON cm.conversation_id = $1 AND cm.user_id = ps.user_id AND cm.left_at IS NULL
    JOIN conversations cv ON cv.id = $1 AND cv.deleted_at IS NULL
    JOIN messages msg ON msg.id = $9 AND msg.conversation_id = $1 AND msg.deleted_at IS NULL
    LEFT JOIN conversation_read_state crs ON crs.conversation_id = $1 AND crs.user_id = ps.user_id
    LEFT JOIN thread_read_state trs ON $2::uuid IS NOT NULL AND trs.root_message_id = $2::uuid AND trs.user_id = ps.user_id
   WHERE ($7::boolean OR ps.user_id = ANY($4::uuid[])) AND ps.user_id <> $8 AND ps.vapid_key_id = $6
     AND (CASE WHEN $2::uuid IS NULL THEN COALESCE(crs.last_read_seq, 0) ELSE COALESCE(trs.last_read_seq, 0) END) < $3
   ORDER BY ps.id`;

export function createPgPushStore(pool: pg.Pool): PushStore {
  return {
    async upsert(sub) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, vapid_key_id, created_at, last_success_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
           p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, vapid_key_id = EXCLUDED.vapid_key_id,
           -- 같은 기기 재등록(앱 재실행마다 upsert)은 성공 기록을 지우지 않는다. 키·p256dh·auth가 바뀐 경우만 초기화.
           last_success_at = CASE
             WHEN push_subscriptions.p256dh = EXCLUDED.p256dh AND push_subscriptions.auth = EXCLUDED.auth
              AND push_subscriptions.vapid_key_id = EXCLUDED.vapid_key_id THEN push_subscriptions.last_success_at
             ELSE NULL END
         RETURNING id`,
        [randomUUID(), sub.userId, sub.sessionId, sub.endpoint, sub.p256dh, sub.auth, sub.keyId, sub.at],
      );
      const id = res.rows[0]?.id;
      if (id === undefined) throw new Error('push 구독 저장 실패');
      return id;
    },
    async deleteOwn(id, userId) {
      const res = await pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2', [id, userId]);
      return (res.rowCount ?? 0) > 0;
    },
    async deleteById(id) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
    },
    async deleteBySessions(sessionIds) {
      if (sessionIds.length === 0) return;
      await pool.query('DELETE FROM push_subscriptions WHERE session_id = ANY($1::uuid[])', [sessionIds]);
    },
    async markSuccess(id, at) {
      await pool.query('UPDATE push_subscriptions SET last_success_at = $2 WHERE id = $1', [id, at]);
    },
    async context(conversationId, threadRootId) {
      const res = await pool.query<{ bot_dm: boolean; channel: boolean; root_author_id: string | null; root_author_kind: 'human' | 'bot' | null }>(
        `SELECT (c.kind = 'dm' AND EXISTS (
                   SELECT 1 FROM conversation_members m JOIN users u ON u.id = m.user_id
                    WHERE m.conversation_id = c.id AND u.kind = 'bot')) AS bot_dm,
                c.kind = 'channel' AS channel,
                ra.author_id AS root_author_id,
                ra.kind AS root_author_kind
           FROM conversations c
           LEFT JOIN LATERAL (
             SELECT r.author_id, ru.kind FROM messages r JOIN users ru ON ru.id = r.author_id
              WHERE r.id = $2::uuid AND r.conversation_id = c.id) ra ON true
          WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [conversationId, threadRootId],
      );
      const row = res.rows[0];
      return {
        botDm: row?.bot_dm === true,
        channel: row?.channel === true,
        rootAuthorId: row?.root_author_id ?? null,
        rootAuthorKind: row?.root_author_kind ?? null,
      };
    },
    async isLive(messageId) {
      const res = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL', [messageId]);
      return (res.rowCount ?? 0) > 0;
    },
    async targets(q) {
      const res = await pool.query<{ id: string; user_id: string; endpoint: string; p256dh: string; auth: string }>(TARGETS_SQL, [
        q.conversationId,
        q.threadRootId,
        q.seq,
        q.userIds,
        q.now,
        q.keyId,
        q.everyone,
        q.authorId,
        q.messageId,
      ]);
      return res.rows.map((r) => ({ id: r.id, userId: r.user_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
    },
  };
}
