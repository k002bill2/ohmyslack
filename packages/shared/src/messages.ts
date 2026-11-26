import { z } from 'zod';
import { attachmentIdsSchema, attachmentViewSchema } from './attachments.js';

/** 메시지 HTTP 계약(정본: TRD §3 messages route, §5 본문 상한). 테스트는 이 상수를 읽는다(정본 수치 복제 금지). */
export const MESSAGE_BODY_MAX = 4000;
/** 이력·답글 목록 페이지 상한(TRD §3: 목록 최대 100, offset 금지). */
export const HISTORY_LIMIT_MAX = 100;
/** 한 메시지의 mention 후보 ID 상한(payload 상한 검증용). */
export const MENTION_IDS_MAX = 100;

/** 본문 길이는 Unicode code point로 센다(UTF-16 단위인 zod `.max`와 다르다). */
export function codePointLength(text: string): number {
  return [...text].length;
}

const bodySchema = z
  .string()
  .max(MESSAGE_BODY_MAX * 2)
  .refine((b) => b.trim().length > 0 && codePointLength(b) <= MESSAGE_BODY_MAX);

const mentionIdsSchema = z.array(z.uuid()).max(MENTION_IDS_MAX);

export const messageCreateRequestSchema = z
  .object({
    client_message_id: z.uuid(),
    body: bodySchema,
    thread_root_id: z.uuid().nullable().optional(),
    mention_user_ids: mentionIdsSchema.optional(),
    /** 같은 요청자가 올린 같은 대화의 미결속 첨부(최대 4, TRD §3·§6-1). 멱등 payload 비교에 포함. */
    attachment_ids: attachmentIdsSchema.optional(),
  })
  .strict();

export type MessageCreateRequest = z.infer<typeof messageCreateRequestSchema>;

export const messageEditRequestSchema = z
  .object({
    body: bodySchema,
    mention_user_ids: mentionIdsSchema.optional(),
  })
  .strict();

export type MessageEditRequest = z.infer<typeof messageEditRequestSchema>;

const seqParam = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const historyQuerySchema = z
  .object({
    before_seq: seqParam.optional(),
    after_seq: seqParam.optional(),
    around_seq: seqParam.optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_LIMIT_MAX).optional(),
    roots_only: z.enum(['true', 'false']).optional(),
  })
  .strict()
  .refine((q) => [q.before_seq, q.after_seq, q.around_seq].filter((v) => v !== undefined).length <= 1);

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const repliesQuerySchema = z
  .object({
    before_seq: seqParam.optional(),
    after_seq: seqParam.optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_LIMIT_MAX).optional(),
  })
  .strict()
  .refine((q) => q.before_seq === undefined || q.after_seq === undefined);

export type RepliesQuery = z.infer<typeof repliesQuerySchema>;

/** 메시지 현재 상태 projection. 삭제 tombstone은 body null·mention 빈 배열. */
export const messageSchema = z.object({
  id: z.uuid(),
  conversation_id: z.uuid(),
  seq: z.number().int(),
  author_id: z.uuid(),
  /** 작성자 종류(TRD §5-2 8: 서버가 users.kind에서 결정, 요청 입력 아님). */
  author_kind: z.enum(['human', 'bot']),
  client_message_id: z.uuid(),
  thread_root_id: z.uuid().nullable(),
  body: z.string().nullable(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  mention_user_ids: z.array(z.uuid()),
  /** 원문만: 살아 있는 답글 수. 답글은 null. */
  root_reply_count: z.number().int().nullable(),
  /** 첨부 projection(TRD §4). 선택 필드가 아니라 기본 빈 배열이다(첨부 이전 서버 응답도 같은 모양으로 읽힌다). */
  attachments: z.array(attachmentViewSchema).default([]),
});

export type MessageView = z.infer<typeof messageSchema>;
export type MessageAuthorKind = MessageView['author_kind'];

export const messageWriteResponseSchema = z.object({
  message: messageSchema,
  seq: z.number().int(),
  change_id: z.number().int(),
  mention_user_ids: z.array(z.uuid()),
});

export type MessageWriteResponse = z.infer<typeof messageWriteResponseSchema>;

export const messageDeleteResponseSchema = z.object({
  message_id: z.uuid(),
  seq: z.number().int(),
  deleted_at: z.string(),
  change_id: z.number().int(),
});

export type MessageDeleteResponse = z.infer<typeof messageDeleteResponseSchema>;

export const historyResponseSchema = z.object({
  messages: z.array(messageSchema),
  has_more: z.boolean(),
});

export type HistoryResponse = z.infer<typeof historyResponseSchema>;

export const repliesResponseSchema = z.object({
  root: messageSchema,
  replies: z.array(messageSchema),
  has_more: z.boolean(),
});

export type RepliesResponse = z.infer<typeof repliesResponseSchema>;

/** 알림 미리보기 최대 길이(code point, TRD §6-2). 초과분은 잘라 `…`을 붙인다. */
export const MESSAGE_PREVIEW_MAX = 100;

/**
 * `GET /api/messages/{id}/preview` 응답(TRD §6-2). SW가 push 수신 뒤 로그인 세션으로 가져가는 평문 미리보기.
 * 삭제된 메시지·평문이 빈 메시지는 `null`(SW는 고정 문구로 폴백).
 */
export const messagePreviewResponseSchema = z.strictObject({
  text: z.string().min(1).nullable(),
});

export type MessagePreviewResponse = z.infer<typeof messagePreviewResponseSchema>;
