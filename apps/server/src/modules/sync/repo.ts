import type pg from 'pg';
import { SYNC_RETENTION_DAYS, SYNC_RETENTION_ROWS } from '../../shared.js';
import { MESSAGE_COLUMNS, toRecord, type MessageRow } from '../messages/index.js';
import type { FoldedChange, ReadMergeResult, ReadTarget, SyncStore } from './store.js';

/** sync·읽음 저장소의 pg 구현(TRD §2·§3). 모든 SQL은 파라미터 바인딩만 쓴다(NC-25). */

const WATERMARK_SQL = 'SELECT last_change_id::text AS id FROM sync_clock WHERE id = 1';

/** 보존 경계 = max(마지막 change - 100,000, 30일보다 오래된 마지막 change). 정리 작업은 별도(경계 계산만). */
const RETENTION_FLOOR_SQL = `SELECT GREATEST(
    (SELECT last_change_id FROM sync_clock WHERE id = 1) - $2::bigint,
    COALESCE((SELECT max(change_id) FROM conversation_changes WHERE created_at < $1::timestamptz - make_interval(days => $3::int)), 0),
    0)::text AS floor`;

const SCAN_SQL = `SELECT change_id::text AS change_id, conversation_id, message_id FROM conversation_changes
  WHERE change_id > $1 AND change_id <= $2 ORDER BY change_id LIMIT $3`;

const ACTIVE_OF_SQL = `SELECT conversation_id FROM conversation_members
  WHERE user_id = $1 AND left_at IS NULL AND conversation_id = ANY($2::uuid[])`;

const SNAPSHOT_SQL = `SELECT ${MESSAGE_COLUMNS} FROM messages m
  WHERE m.conversation_id = $1 AND ($2::bigint IS NULL OR m.seq < $2) ORDER BY m.seq DESC LIMIT $3`;

/** 본문 읽음: 요청 seq가 대화의 실제 최대 원문 seq 이하일 때만 쓴다. 기존 위치보다 뒤로 가지 않는다(max 병합). */
const MERGE_BODY_READ_SQL = `WITH bound AS (
    SELECT COALESCE(max(seq), 0) AS max_seq FROM messages WHERE conversation_id = $1 AND thread_root_id IS NULL)
  INSERT INTO conversation_read_state (conversation_id, user_id, last_read_seq, updated_at)
  SELECT $1, $2, $3, $4 FROM bound WHERE $3 <= bound.max_seq
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET last_read_seq = GREATEST(conversation_read_state.last_read_seq, EXCLUDED.last_read_seq), updated_at = EXCLUDED.updated_at
  RETURNING last_read_seq::text AS last_read_seq, updated_at`;

/** 스레드 읽음: root가 이 대화의 원문이고, 요청 seq가 그 root 답글의 실제 최대 seq(답글 없으면 root seq) 이하일 때만. */
const MERGE_THREAD_READ_SQL = `WITH root AS (
    SELECT seq FROM messages WHERE conversation_id = $1 AND id = $5 AND thread_root_id IS NULL),
  bound AS (
    SELECT COALESCE((SELECT max(r.seq) FROM messages r WHERE r.conversation_id = $1 AND r.thread_root_id = $5), root.seq) AS max_seq FROM root)
  INSERT INTO thread_read_state (root_message_id, user_id, last_read_seq, updated_at)
  SELECT $5, $2, $3, $4 FROM bound WHERE $3 <= bound.max_seq
  ON CONFLICT (root_message_id, user_id) DO UPDATE
    SET last_read_seq = GREATEST(thread_read_state.last_read_seq, EXCLUDED.last_read_seq), updated_at = EXCLUDED.updated_at
  RETURNING last_read_seq::text AS last_read_seq, updated_at`;

interface ScanRow {
  change_id: string;
  conversation_id: string;
  message_id: string;
}

export function createPgSyncStore(pool: pg.Pool): SyncStore {
  return {
    async watermark() {
      const res = await pool.query<{ id: string }>(WATERMARK_SQL);
      return Number(res.rows[0]?.id ?? 0);
    },
    async retentionFloor(now) {
      const res = await pool.query<{ floor: string }>(RETENTION_FLOOR_SQL, [now, SYNC_RETENTION_ROWS, SYNC_RETENTION_DAYS]);
      return Number(res.rows[0]?.floor ?? 0);
    },
    async scan({ userId, after, through, limit }) {
      const scanned = (await pool.query<ScanRow>(SCAN_SQL, [after, through, limit])).rows;
      const scannedThrough = scanned.length < limit ? through : Number(scanned.at(-1)?.change_id ?? through);
      if (scanned.length === 0) return { scannedThrough, changes: [] };
      const conversationIds = [...new Set(scanned.map((r) => r.conversation_id))];
      const active = new Set((await pool.query<{ conversation_id: string }>(ACTIVE_OF_SQL, [userId, conversationIds])).rows.map((r) => r.conversation_id));
      const latest = new Map<string, number>();
      for (const row of scanned) if (active.has(row.conversation_id)) latest.set(row.message_id, Number(row.change_id));
      if (latest.size === 0) return { scannedThrough, changes: [] };
      const loaded = await pool.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = ANY($1::uuid[])`, [[...latest.keys()]]);
      const changes = loaded.rows
        .map((row): FoldedChange => ({ changeId: latest.get(row.id) ?? 0, message: toRecord(row) }))
        .sort((x, y) => x.changeId - y.changeId);
      return { scannedThrough, changes };
    },
    async snapshot(conversationId, beforeSeq, limit) {
      const rows = (await pool.query<MessageRow>(SNAPSHOT_SQL, [conversationId, beforeSeq ?? null, limit + 1])).rows.map(toRecord);
      return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
    },
    async mergeRead(target: ReadTarget): Promise<ReadMergeResult> {
      const base = [target.conversationId, target.userId, target.lastReadSeq, target.at];
      const res =
        target.threadRootId === null
          ? await pool.query<{ last_read_seq: string; updated_at: Date }>(MERGE_BODY_READ_SQL, base)
          : await pool.query<{ last_read_seq: string; updated_at: Date }>(MERGE_THREAD_READ_SQL, [...base, target.threadRootId]);
      const row = res.rows[0];
      return row === undefined ? { ok: false } : { ok: true, lastReadSeq: Number(row.last_read_seq), updatedAt: row.updated_at };
    },
  };
}
