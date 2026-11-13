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

/* ── 문서·텍스트 첨부(정본: TRD §6-1-1 R3.5·R3.6, ADR-002 §4) ─────────────────────────────── */

/** 문서 9종 저장 MIME(TRD §6-1-1 (1) 표). OOXML 매크로형 3종은 매크로 감지 시 저장 MIME. */
export const ATTACHMENT_DOC_MIMES = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/hwp+zip',
  'application/x-hwp',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
] as const);
/** 텍스트 계열 3종(R3.6). 응답 Content-Type은 `; charset=utf-8`을 붙인다. */
export const ATTACHMENT_TEXT_MIMES = Object.freeze(['text/plain', 'text/markdown', 'text/csv'] as const);
export type AttachmentDocMime = (typeof ATTACHMENT_DOC_MIMES)[number];
export type AttachmentTextMime = (typeof ATTACHMENT_TEXT_MIMES)[number];
/** 파일명이 필수인 계열(문서 + 텍스트). 마이그레이션 0005의 `(mime IN …) = (filename IS NOT NULL)` CHECK와 같은 집합. */
export const ATTACHMENT_FILE_MIMES = Object.freeze([...ATTACHMENT_DOC_MIMES, ...ATTACHMENT_TEXT_MIMES] as const);
export type AttachmentFileMime = AttachmentDocMime | AttachmentTextMime;
/** 저장 가능한 모든 MIME(미디어 4 + 문서 + 텍스트). */
export const ATTACHMENT_ALL_MIMES = Object.freeze([...ATTACHMENT_MIMES, ...ATTACHMENT_FILE_MIMES] as const);
export type AttachmentAnyMime = AttachmentMime | AttachmentFileMime;

/** 문서·텍스트 파일당 상한 25 MiB(26,214,400바이트). 업로드 라우트(사람·봇) body 상한도 이 값. */
export const ATTACHMENT_DOC_MAX_BYTES = 25 * 1024 * 1024;
/** 문서·텍스트 보존(TRD §6-1-1 (7)): 90일. */
export const ATTACHMENT_DOC_RETENTION_DAYS = 90;
/** 사람 계정 동시 업로드 상한(초과 429, TRD §6-1-1 (2) ★). */
export const ATTACHMENT_HUMAN_CONCURRENT_UPLOADS = 2;

/** 판정기 자원 상한(TRD §6-1-1 (2) ★). */
export const DOC_ZIP_MAX_ENTRIES = 5000;
export const DOC_ZIP_MAX_CD_BYTES = 2 * 1024 * 1024;
export const DOC_ZIP_MAX_NAME_BYTES = 1024;
export const DOC_ZIP_EOCD_SCAN_BYTES = 22 + 65535;
export const DOC_OLE_MAX_DIR_SECTORS = 1024;
export const DOC_OLE_MAX_DIR_ENTRIES = 4096;
/** FAT·DIFAT·미니 FAT 체인 순회 총 단계 상한(= 25 MiB / 512B). */
export const DOC_OLE_MAX_CHAIN_STEPS = ATTACHMENT_DOC_MAX_BYTES / 512;
export const DOC_SNIFF_DEADLINE_MS = 1000;

/** 파일명 전달 헤더(퍼센트 인코딩 UTF-8)와 상한(TRD §6-1-1 (5)). */
export const ATTACHMENT_FILENAME_HEADER = 'x-attachment-filename';
export const ATTACHMENT_FILENAME_HEADER_MAX_BYTES = 1024;
export const ATTACHMENT_FILENAME_MAX_CHARS = 200;
export const ATTACHMENT_FILENAME_MAX_BYTES = 255;
export const ATTACHMENT_FILENAME_FALLBACK_STEM = 'document';

/** 415 하위 코드(TRD §3 R3.6). 사람·봇 업로드 공통, 본문·파일명 미포함. */
export const ATTACHMENT_415_CODES = Object.freeze(['unsupported_media_type', 'extension_mismatch', 'macro_extension_mismatch', 'encrypted_document'] as const);
export type Attachment415Code = (typeof ATTACHMENT_415_CODES)[number];

export function isAttachmentFileMime(value: string): value is AttachmentFileMime {
  return (ATTACHMENT_FILE_MIMES as readonly string[]).includes(value);
}

export function isAttachmentMime(value: string): value is AttachmentMime {
  return (ATTACHMENT_MIMES as readonly string[]).includes(value);
}

/** 메시지 projection의 첨부 행(이력·sync·WS·봇 공통). `expired`=바이트 삭제됨(`deleted_at` 존재 또는 `expires_at` 경과). */
export const attachmentViewSchema = z.object({
  id: z.uuid(),
  mime: z.enum(ATTACHMENT_ALL_MIMES),
  byte_size: z.number().int(),
  duration_ms: z.number().int().nullable().optional(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  expires_at: z.string(),
  expired: z.boolean(),
  /** 문서·텍스트 계열의 정규화 원 파일명(미디어는 null/생략, TRD §6-1-1 (5)). */
  filename: z.string().nullable().optional(),
  /** 매크로 감지(TRD §6-1-1 (3)). 미디어·PDF·텍스트는 false. */
  has_macros: z.boolean().optional(),
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
