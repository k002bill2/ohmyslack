import type pg from 'pg';
import { withTransaction } from '../../db/pool.js';
import type { AttachmentAnyMime } from '../../shared.js';

/**
 * 첨부 저장소(pg, 정본: TRD §2 `attachments`·`attachment_blobs`, §6-1). 첨부 바이트를 읽고 쓰는 SQL은 이 파일에만 있다(B10).
 * 메시지 모듈은 결속·삭제 트랜잭션 안에서 아래 함수(bindInTx·purgeMessageBlobsInTx)를 호출만 한다.
 * 모든 SQL은 파라미터 바인딩만 쓴다(NC-25).
 */
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface AttachmentMeta {
  readonly id: string;
  readonly conversationId: string;
  readonly uploaderId: string;
  readonly messageId: string | null;
  readonly mime: AttachmentAnyMime;
  readonly byteSize: number;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  /** 문서·텍스트의 정규화 파일명(미디어 null). */
  readonly filename: string | null;
  readonly hasMacros: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly deletedAt: Date | null;
}

export interface NewAttachment extends Omit<AttachmentMeta, 'messageId' | 'deletedAt'> {
  readonly sha256: string;
  readonly bytes: Buffer;
}

interface MetaRow {
  id: string;
  conversation_id: string;
  uploader_id: string;
  message_id: string | null;
  mime: AttachmentAnyMime;
  byte_size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  filename: string | null;
  has_macros: boolean;
  created_at: Date;
  expires_at: Date;
  deleted_at: Date | null;
}

const META_COLUMNS = 'id, conversation_id, uploader_id, message_id, mime, byte_size, duration_ms, width, height, filename, has_macros, created_at, expires_at, deleted_at';

function toMeta(r: MetaRow): AttachmentMeta {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    uploaderId: r.uploader_id,
    messageId: r.message_id,
    mime: r.mime,
    byteSize: r.byte_size,
    durationMs: r.duration_ms,
    width: r.width,
    height: r.height,
    filename: r.filename,
    hasMacros: r.has_macros,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    deletedAt: r.deleted_at,
  };
}

/**
 * 메시지 projection의 첨부 열(TRD §4). 순서 = 결속 요청 순서, 0007 이전 결속 행(NULL)은 뒤에 created_at, id 순(TRD R3.7). `expired` = 바이트 삭제됨(`deleted_at`) 또는 보존 기한 경과. bytea는 읽지 않는다.
 * `m`은 messages 별칭이다(messages repo의 MESSAGE_COLUMNS에 끼워 쓴다).
 */
export const ATTACHMENTS_PROJECTION_SQL = `COALESCE((SELECT json_agg(json_build_object(
    'id', a.id, 'mime', a.mime, 'byte_size', a.byte_size, 'duration_ms', a.duration_ms, 'width', a.width, 'height', a.height,
    'filename', a.filename, 'has_macros', a.has_macros, 'expires_at', a.expires_at, 'expired', (a.deleted_at IS NOT NULL OR a.expires_at <= now())) ORDER BY a.bind_order NULLS LAST, a.created_at, a.id)
  FROM attachments a WHERE a.message_id = m.id), '[]'::json) AS attachments`;

export interface AttachmentProjectionRow {
  id: string;
  mime: AttachmentAnyMime;
  byte_size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  filename: string | null;
  has_macros: boolean;
  expires_at: string;
  expired: boolean;
}

export type BindResult = 'ok' | 'invalid';

/**
 * 결속(메시지 생성 트랜잭션 안, 메시지 INSERT 뒤): 요청 ID가 모두 **같은 요청자·같은 대화·미결속·미삭제·유예 1시간 안**일 때만
 * message_id를 채운다. 행을 FOR UPDATE로 잠가 동시 결속·미결속 정리와 직렬화한다. 하나라도 어긋나면 'invalid'(호출자가 롤백).
 */
export async function bindInTx(
  client: pg.PoolClient,
  input: { readonly ids: readonly string[]; readonly messageId: string; readonly conversationId: string; readonly uploaderId: string; readonly notBefore: Date },
): Promise<BindResult> {
  if (input.ids.length === 0) return 'ok';
  if (new Set(input.ids).size !== input.ids.length) return 'invalid';
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM attachments WHERE id = ANY($1::uuid[]) AND conversation_id = $2 AND uploader_id = $3
       AND message_id IS NULL AND deleted_at IS NULL AND created_at > $4 ORDER BY id FOR UPDATE`,
    [[...input.ids], input.conversationId, input.uploaderId, input.notBefore],
  );
  if (locked.rows.length !== input.ids.length) return 'invalid';
  // 위치 = 요청 배열에서의 0부터 순번(TRD R3.7). 중복 ID는 위에서 이미 'invalid'라 순번은 유일하다.
  await client.query(
    `UPDATE attachments a SET message_id = $2, bind_order = o.ord - 1
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord) WHERE a.id = o.id`,
    [[...input.ids], input.messageId],
  );
  return 'ok';
}

/** 멱등 재시도 비교용: 메시지에 결속된 첨부 ID(정렬). */
export async function boundIdsOf(db: Queryable, messageId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>('SELECT id FROM attachments WHERE message_id = $1 ORDER BY id', [messageId]);
  return res.rows.map((r) => r.id);
}

/** 메시지 삭제 시 즉시 바이트 삭제(TRD §6-1). 메타는 남기고 deleted_at을 찍는다(만료 자리표시자). 같은 트랜잭션에서 호출한다. */
export async function purgeMessageBlobsInTx(client: pg.PoolClient, messageId: string, at: Date): Promise<void> {
  await client.query(
    `WITH gone AS (UPDATE attachments SET deleted_at = COALESCE(deleted_at, $2) WHERE message_id = $1 RETURNING id)
     DELETE FROM attachment_blobs WHERE attachment_id IN (SELECT id FROM gone)`,
    [messageId, at],
  );
}

export interface RetentionResult {
  readonly unboundDeleted: number;
  readonly blobsDeleted: number;
}

/**
 * 저장 트랜잭션 안 사전 검사(INSERT 전, 같은 client). 거부는 throw — 트랜잭션이 롤백돼 메타·바이트 저장 0.
 * 검사가 잡은 행 잠금은 COMMIT까지 유지된다(봇 업로드의 권한 회수 경쟁 차단, W-26 Codex r3). 사람 경로는 넘기지 않는다.
 */
export type InTxCheck = (client: pg.PoolClient, conversationId: string) => Promise<void>;

export interface AttachmentsStore {
  insert(a: NewAttachment, check?: InTxCheck): Promise<AttachmentMeta>;
  get(id: string): Promise<AttachmentMeta | undefined>;
  /** 바이트. 행이 없으면(삭제됨) undefined. */
  bytes(id: string): Promise<Buffer | undefined>;
  /** 보존 삭제 1회(미결속 유예 경과 행 삭제, 보존 기한 경과·삭제된 메시지의 바이트 삭제 + 메타 유지). */
  retain(now: Date, unboundBefore: Date): Promise<RetentionResult>;
}

/**
 * 사람 업로드 저장 tx 안 대화 확인·잠금(FR-CONV-06): 삭제(UPDATE conversations)와 충돌하는 FOR SHARE.
 * 가드 통과 후 삭제가 커밋됐으면 false(호출자가 404로 거부해 저장 0).
 */
export async function lockLiveConversation(client: pg.PoolClient, conversationId: string): Promise<boolean> {
  const res = await client.query('SELECT 1 FROM conversations WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [conversationId]);
  return (res.rowCount ?? 0) > 0;
}

/** 메타·바이트를 한 트랜잭션으로 넣는다(부분 저장 0). */
async function insertTx(pool: pg.Pool, a: NewAttachment, check: InTxCheck | undefined): Promise<AttachmentMeta> {
  const row = await withTransaction(pool, async (client) => {
    if (check !== undefined) await check(client, a.conversationId);
    const res = await client.query<MetaRow>(
      `INSERT INTO attachments (id, conversation_id, uploader_id, mime, byte_size, sha256, duration_ms, width, height, filename, has_macros, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${META_COLUMNS}`,
      [a.id, a.conversationId, a.uploaderId, a.mime, a.byteSize, a.sha256, a.durationMs, a.width, a.height, a.filename, a.hasMacros, a.createdAt, a.expiresAt],
    );
    await client.query('INSERT INTO attachment_blobs (attachment_id, bytes) VALUES ($1, $2)', [a.id, a.bytes]);
    return { commit: true, value: res.rows[0] };
  });
  if (row === undefined) throw new Error('첨부 행을 다시 읽지 못했습니다');
  return toMeta(row);
}

/**
 * 보존 삭제(TRD §6-1). 각 문장은 단일 문장 원자성으로 동작한다:
 * ① 미결속 유예 경과 → 행 삭제(바이트는 CASCADE). 동시 결속이 잠근 행은 잠금 해제 후 WHERE를 다시 평가해 결속됐으면 건너뛴다.
 * ② 보존 기한 경과·메시지가 삭제된 결속 첨부 → deleted_at + 바이트 삭제(메타 유지).
 */
async function retain(pool: pg.Pool, now: Date, unboundBefore: Date): Promise<RetentionResult> {
  const unbound = await pool.query('DELETE FROM attachments WHERE message_id IS NULL AND created_at <= $1', [unboundBefore]);
  const expired = await pool.query(
    `WITH gone AS (
       UPDATE attachments a SET deleted_at = $1
       WHERE a.deleted_at IS NULL AND a.message_id IS NOT NULL
         AND (a.expires_at <= $1 OR EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id AND m.deleted_at IS NOT NULL))
       RETURNING a.id)
     DELETE FROM attachment_blobs WHERE attachment_id IN (SELECT id FROM gone)`,
    [now],
  );
  // ③ 안전망: deleted_at이 찍혔는데 남은 바이트(이전 실행 중단 등)도 지운다.
  const orphan = await pool.query(
    'DELETE FROM attachment_blobs b USING attachments a WHERE a.id = b.attachment_id AND a.deleted_at IS NOT NULL',
  );
  return { unboundDeleted: unbound.rowCount ?? 0, blobsDeleted: (expired.rowCount ?? 0) + (orphan.rowCount ?? 0) };
}

export function createPgAttachmentsStore(pool: pg.Pool): AttachmentsStore {
  return {
    insert: (a, check) => insertTx(pool, a, check),
    async get(id) {
      const res = await pool.query<MetaRow>(`SELECT ${META_COLUMNS} FROM attachments WHERE id = $1`, [id]);
      const row = res.rows[0];
      return row === undefined ? undefined : toMeta(row);
    },
    async bytes(id) {
      const res = await pool.query<{ bytes: Buffer }>('SELECT bytes FROM attachment_blobs WHERE attachment_id = $1', [id]);
      return res.rows[0]?.bytes;
    },
    retain: (now, unboundBefore) => retain(pool, now, unboundBefore),
  };
}
