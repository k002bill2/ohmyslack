import { z } from 'zod';

/** 첨부 계약(정본: TRD §6-1, §3 attachments 라우트, §4 첨부 projection). 테스트는 이 상수를 읽는다(정본 수치 복제 금지). */
export const ATTACHMENT_MIMES = Object.freeze(['audio/mpeg', 'image/png', 'image/jpeg', 'image/webp'] as const);
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];
/** 파일당 상한 10 MiB(10,485,760바이트). 업로드 라우트만 이 body 상한 예외를 쓴다. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 메시지당 첨부 상한. */
export const ATTACHMENTS_PER_MESSAGE_MAX = 4;
/** 미결속 첨부 유예(업로드 후 이 시간 안에 메시지에 결속되지 않으면 삭제). */
export const ATTACHMENT_UNBOUND_TTL_MS = 60 * 60 * 1000;
/** 보존(제안): 오디오 30일, 이미지 90일. 경과 시 바이트 삭제·메타 유지. */
export const ATTACHMENT_RETENTION_DAYS = Object.freeze({ audio: 30, image: 90 } as const);

export function isAttachmentMime(value: string): value is AttachmentMime {
  return (ATTACHMENT_MIMES as readonly string[]).includes(value);
}

/** 메시지 projection의 첨부 행(이력·sync·WS·봇 공통). `expired`=바이트 삭제됨(`deleted_at` 존재 또는 `expires_at` 경과). */
export const attachmentViewSchema = z.object({
  id: z.uuid(),
  mime: z.enum(ATTACHMENT_MIMES),
  byte_size: z.number().int(),
  duration_ms: z.number().int().nullable().optional(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  expires_at: z.string(),
  expired: z.boolean(),
});

export type AttachmentView = z.infer<typeof attachmentViewSchema>;

export const attachmentIdsSchema = z.array(z.uuid()).max(ATTACHMENTS_PER_MESSAGE_MAX);

export const attachmentUploadQuerySchema = z.object({ conversation_id: z.uuid() }).strict();

/** 업로드 응답: 미결속 첨부(메시지 생성 `attachment_ids`로 결속). */
export const attachmentUploadResponseSchema = z.object({
  attachment_id: z.uuid(),
  attachment: attachmentViewSchema,
});

export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;
