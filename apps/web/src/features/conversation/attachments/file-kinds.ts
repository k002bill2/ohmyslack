import {
  ATTACHMENT_DOC_MAX_BYTES,
  ATTACHMENT_FILE_MIMES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIMES,
  isAttachmentFileMime,
  type AttachmentFileMime,
} from '../../../../../../packages/shared/src/index.js';
import { DOCUMENT_KIND_COPY, type DocumentKind } from '../../../ui/copy.js';

/**
 * 작성기·문서 행의 형식 표(ADR-002 §4-2, TRD §6-1-1 (1) 표의 확장자 열, UI_STATES §2-13).
 * 키 집합은 shared MIME 상수에서 오고(`Record`가 누락을 타입 오류로 만든다), 이 파일은 MIME→확장자·표지 대응만 둔다.
 * 서버가 내용으로 최종 판정한다 — 이 표는 사전 거부·`accept`·표지용이다.
 */
type ComposerImageMime = Extract<(typeof ATTACHMENT_MIMES)[number], `image/${string}`>;

const IMAGE_EXTENSIONS: Readonly<Record<ComposerImageMime, readonly string[]>> = Object.freeze({
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
});

const FILE_FORMATS: Readonly<Record<AttachmentFileMime, { readonly ext: readonly string[]; readonly kind: DocumentKind }>> = Object.freeze({
  'application/pdf': { ext: ['pdf'], kind: 'pdf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'], kind: 'word' },
  'application/vnd.ms-word.document.macroEnabled.12': { ext: ['docm'], kind: 'word' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['xlsx'], kind: 'excel' },
  'application/vnd.ms-excel.sheet.macroEnabled.12': { ext: ['xlsm'], kind: 'excel' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['pptx'], kind: 'powerpoint' },
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12': { ext: ['pptm'], kind: 'powerpoint' },
  'application/hwp+zip': { ext: ['hwpx'], kind: 'hwp' },
  'application/x-hwp': { ext: ['hwp'], kind: 'hwp' },
  'application/msword': { ext: ['doc'], kind: 'word' },
  'application/vnd.ms-excel': { ext: ['xls'], kind: 'excel' },
  'application/vnd.ms-powerpoint': { ext: ['ppt'], kind: 'powerpoint' },
  'text/plain': { ext: ['txt'], kind: 'txt' },
  'text/markdown': { ext: ['md'], kind: 'md' },
  'text/csv': { ext: ['csv'], kind: 'csv' },
});

const IMAGE_EXT_SET: ReadonlySet<string> = new Set(Object.values(IMAGE_EXTENSIONS).flat());
const DOC_EXT_KIND: ReadonlyMap<string, DocumentKind> = new Map(
  ATTACHMENT_FILE_MIMES.flatMap((m) => FILE_FORMATS[m].ext.map((e) => [e, FILE_FORMATS[m].kind] as const)),
);

/** 파일 선택 `accept`(G-54): 이미지 3종 + 문서 + 텍스트 3종 확장자. */
export const COMPOSER_ACCEPT: string = [...IMAGE_EXT_SET, ...DOC_EXT_KIND.keys()].map((e) => `.${e}`).join(',');

/** 마지막 `.` 뒤 확장자(소문자, 점 제외). 없으면 ''. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

export type ComposerFileKind = 'image' | 'document';

/** 선택한 파일의 계열(확장자 기준, G-55 「형식은 확장자로 클라이언트가 고른다」). 허용 밖이면 null. */
export function composerFileKind(name: string): ComposerFileKind | null {
  const ext = extensionOf(name);
  if (IMAGE_EXT_SET.has(ext)) return 'image';
  if (DOC_EXT_KIND.has(ext)) return 'document';
  return null;
}

/** 계열별 파일당 상한(이미지 10 MiB, 문서·텍스트 25 MiB — TRD §6-1·§6-1-1). */
export function maxBytesFor(kind: ComposerFileKind): number {
  return kind === 'image' ? ATTACHMENT_MAX_BYTES : ATTACHMENT_DOC_MAX_BYTES;
}

/** 작성기 칩 표지(G-59): 문서는 확장자로 고른 형식, 이미지·허용 밖은 null. */
export function composerKindLabel(name: string): string | null {
  const kind = DOC_EXT_KIND.get(extensionOf(name));
  return kind === undefined ? null : DOCUMENT_KIND_COPY[kind];
}

/** 메시지 첨부 행의 형식 표지(G-59, 서버 판정 mime 기준). 문서·텍스트가 아니면 null. */
export function documentKindLabel(mime: string): string | null {
  return isAttachmentFileMime(mime) ? DOCUMENT_KIND_COPY[FILE_FORMATS[mime].kind] : null;
}

/** 파일명 → 이름부·확장자부(점 포함). 확장자가 없거나 이름부가 비면 전체가 이름부(UI_STATES §2-13 말줄임 규칙). */
export function splitFilename(name: string): { readonly stem: string; readonly ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}
