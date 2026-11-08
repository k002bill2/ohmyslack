import { z } from 'zod';
import { HISTORY_LIMIT_MAX, messageSchema } from './messages.js';

/** 동기화·읽음 HTTP 계약(정본: TRD §3 `/api/sync*`·`PUT /api/read-state`, §5 보존 경계). */
export const SYNC_LIMIT_MAX = 500;
/** sync change 보존: 30일 또는 100,000 row 중 먼저 도달하는 경계(TRD §5). */
export const SYNC_RETENTION_DAYS = 30;
export const SYNC_RETENTION_ROWS = 100_000;
export const SNAPSHOT_LIMIT_MAX = HISTORY_LIMIT_MAX;

const cursorParam = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const syncQuerySchema = z
  .object({
    after: cursorParam,
    through: cursorParam.optional(),
    limit: z.coerce.number().int().min(1).max(SYNC_LIMIT_MAX).optional(),
  })
  .strict()
  .refine((q) => q.through === undefined || q.through >= q.after);

export type SyncQuery = z.infer<typeof syncQuerySchema>;

/** sync change 종류(DB `conversation_changes.op`). R3.3 추가 필드 — 기존 소비자는 무시해도 된다. */
export const SYNC_CHANGE_OPS = Object.freeze(['create', 'edit', 'delete'] as const);
export type SyncChangeOp = (typeof SYNC_CHANGE_OPS)[number];

/**
 * 페이지 내 message id별 현재 상태(삭제는 body null·mention 빈 배열 tombstone). `change_id`는 그 메시지의 페이지 내 최신 변경.
 * `op`는 그 메시지 **자신의** 페이지 내 최신 변경 종류다. 답글 변경 때문에 함께 실린 원문(자신의 변경이 페이지에 없음)은 `edit`.
 */
export const syncChangeSchema = z.object({
  change_id: z.number().int(),
  op: z.enum(SYNC_CHANGE_OPS),
  conversation_id: z.uuid(),
  message: messageSchema,
});

export type SyncChange = z.infer<typeof syncChangeSchema>;

export const syncResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  through_cursor: z.number().int(),
  scanned_through: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.number().int(),
});

export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const snapshotQuerySchema = z
  .object({
    conversation_id: z.uuid(),
    before_seq: cursorParam.optional(),
    limit: z.coerce.number().int().min(1).max(SNAPSHOT_LIMIT_MAX).optional(),
  })
  .strict();

export type SnapshotQuery = z.infer<typeof snapshotQuerySchema>;

export const snapshotResponseSchema = z.object({
  snapshot_cursor: z.number().int(),
  conversation_id: z.uuid(),
  messages: z.array(messageSchema),
  has_more: z.boolean(),
  next_before_seq: z.number().int().nullable(),
});

export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;

export const readStateRequestSchema = z
  .object({
    conversation_id: z.uuid(),
    thread_root_id: z.uuid().nullable().optional(),
    last_read_seq: cursorParam,
  })
  .strict();

export type ReadStateRequest = z.infer<typeof readStateRequestSchema>;

/** 병합 후 저장된 위치. WS `read.updated`(TRD §4)와 같은 필드다. */
export const readStateResponseSchema = z.object({
  conversation_id: z.uuid(),
  thread_root_id: z.uuid().nullable(),
  last_read_seq: z.number().int(),
  updated_at: z.string(),
});

export type ReadStateResponse = z.infer<typeof readStateResponseSchema>;
