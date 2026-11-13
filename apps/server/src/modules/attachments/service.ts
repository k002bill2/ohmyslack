import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../http/errors.js';
import {
  ATTACHMENT_DOC_MAX_BYTES,
  ATTACHMENT_DOC_RETENTION_DAYS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_RETENTION_DAYS,
  ATTACHMENT_UNBOUND_TTL_MS,
  DOC_SNIFF_DEADLINE_MS,
  isAttachmentFileMime,
  ATTACHMENT_TEXT_MIMES,
  isAttachmentMime,
} from '../../shared.js';
import { DocSniffError } from './doc-budget.js';
import { checkExtension, classify } from './doc-sniff.js';
import { decodeFilenameHeader, finalizeFilename, parseFilename } from './filename.js';
import type { AccessAction, ConversationsService } from '../conversations/service.js';
import type { OpsLogger } from '../ops/logger.js';
import type { AttachmentMeta, AttachmentsStore, InTxCheck, RetentionResult } from './repo.js';

/** 첨부 서비스(정본: TRD §6-1, DEV_DESIGN B10). 사람·봇 라우트가 같은 인스턴스를 쓴다(TRD §5-2 6항). */
export interface AttachmentsServiceDeps {
  readonly store: AttachmentsStore;
  readonly conversations: ConversationsService;
  readonly clock: () => number;
  /** 판정기 벽시계 보조 상한용 시계(기본 performance.now). 테스트는 가짜 시계를 주입한다. */
  readonly sniffClock?: () => number;
  /** 판정 벽시계 상한 초과 기록용(TRD §6-1-1 (2) `reason=sniff_deadline`). 본문·파일명은 넘기지 않는다(B6). */
  readonly logger?: OpsLogger;
}

export interface Download {
  readonly meta: AttachmentMeta;
  readonly bytes: Buffer;
}

export interface AttachmentsService {
  /**
   * 접근 판정은 호출자의 assertAccess 가드가 먼저 한다. 판정 실패는 415·413이며 저장 0.
   * `check`가 있으면 저장 트랜잭션 안에서 INSERT 전에 실행한다(봇 경로 전용 — 권한 재확인 + 잠금 유지).
   */
  upload(uploaderId: string, conversationId: string, declared: string, bytes: Buffer, filenameHeader?: string, check?: InTxCheck): Promise<AttachmentMeta>;
  /**
   * `attachment` 메타 라우트의 접근 판정(B2): 첨부 ID로 대화를 해석한 뒤 `conversations.service.assertAccess` **하나**로 판정한다.
   * 없는 첨부는 존재를 숨기고 404. 미결속 첨부는 업로더 외에는 404(SR-D-04).
   */
  resolveAccess(userId: string, attachmentId: string, action: AccessAction): Promise<AttachmentMeta>;
  /** 바이트 읽기. 삭제·만료(expired)는 404. */
  read(meta: AttachmentMeta): Promise<Download>;
  /** 보존 삭제 1회 즉시 실행(테스트·타이머 공용). */
  runRetention(): Promise<RetentionResult>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const notFound = (): HttpError => new HttpError(404, 'not_found');

export function retentionMs(mime: string): number {
  if (isAttachmentFileMime(mime)) return ATTACHMENT_DOC_RETENTION_DAYS * DAY_MS;
  return (mime.startsWith('audio/') ? ATTACHMENT_RETENTION_DAYS.audio : ATTACHMENT_RETENTION_DAYS.image) * DAY_MS;
}

/** 판정 결과(저장 직전). 미디어는 파일명 NULL. */
interface Judged {
  readonly mime: AttachmentMeta['mime'];
  readonly filename: string | null;
  readonly hasMacros: boolean;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

const SNIFF_DEADLINE_REASON = 'sniff_deadline';
/** 허용 필드 목록(B6)에 `reason`이 없으므로 `error_code`에 담는다. 본문·파일명·ID는 넣지 않는다. */
const SNIFF_DEADLINE_LOG = Object.freeze({ event: 'attachment_sniff_deadline', error_code: SNIFF_DEADLINE_REASON });

const unsupported = (): HttpError => new HttpError(415, 'unsupported_media_type');

/** 저장 열 `duration_ms`·`width`·`height`(integer = int4) 상한. 넘는 판정값은 INSERT 500 대신 판정 단계 415(SR-D-03). */
const PG_INT4_MAX = 2_147_483_647;
const fitsColumn = (v: number | null): boolean => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= PG_INT4_MAX);

/**
 * TRD §6-1-1 (4) 순서: body 상한 413 → 0바이트 400 → 판정 415 → 종류별 상한(미디어 10 MiB 413) → 확장자 415 → 저장.
 * 파일명 헤더 형식 오류·문서인데 헤더 없음은 400.
 */
export function judge(
  declared: string,
  bytes: Buffer,
  filenameHeader: string | undefined,
  sniffNow: () => number,
  onDeadline: () => void = () => undefined,
): Judged {
  if (bytes.length > ATTACHMENT_DOC_MAX_BYTES) throw new HttpError(413, 'payload_too_large');
  if (bytes.length === 0) throw new HttpError(400, 'invalid_request');
  const decoded = filenameHeader === undefined ? undefined : decodeFilenameHeader(filenameHeader);
  if (filenameHeader !== undefined && decoded === undefined) throw new HttpError(400, 'invalid_request');
  const parsed = decoded === undefined ? undefined : parseFilename(decoded);
  // 텍스트 계열은 확장자로 MIME을 확정하므로 파일명 헤더가 필수다 — 판정보다 먼저 400(TRD §6-1-1 (5)).
  if (parsed === undefined && (ATTACHMENT_TEXT_MIMES as readonly string[]).includes(declared)) throw new HttpError(400, 'invalid_request');
  let match;
  try {
    match = classify(bytes, parsed?.ext ?? '', { now: sniffNow, deadline: sniffNow() + DOC_SNIFF_DEADLINE_MS });
  } catch (error) {
    if (!(error instanceof DocSniffError)) throw error;
    if (error.reason === SNIFF_DEADLINE_REASON) onDeadline();
    // 파일명 없는 UTF-8 본문은 텍스트 계열로 확정할 수 없어 형식 밖(415 unsupported_media_type) — 기존 HTML 415 기대값 유지.
    throw new HttpError(415, error.code);
  }
  if (match.kind === 'media') {
    const m = match.media;
    if (!isAttachmentMime(declared) || m.mime !== declared) throw unsupported();
    // PNG 명세상 폭·높이는 2^31-1 이하다. 헤더 값이 저장 범위 밖이면 형식 위반으로 보고 415(§6-1-1 (4) 순서상 413보다 먼저).
    if (![m.durationMs, m.width, m.height].every(fitsColumn)) throw unsupported();
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw new HttpError(413, 'payload_too_large');
    return { mime: m.mime, filename: null, hasMacros: false, durationMs: m.durationMs, width: m.width, height: m.height };
  }
  // 선언은 declaredType이 소문자로 만든다. 표의 매크로 MIME(`macroEnabled.12`)도 소문자로 비교하고 저장은 표 그대로.
  if (declared !== match.mime.toLowerCase() && declared !== 'application/octet-stream') throw unsupported();
  if (parsed === undefined) throw new HttpError(400, 'invalid_request');
  const ext = checkExtension(match, parsed.ext);
  if (!ext.ok) throw new HttpError(415, ext.code);
  return { mime: match.mime, filename: finalizeFilename(parsed.stem, ext.ext), hasMacros: match.hasMacros, durationMs: null, width: null, height: null };
}

export function isExpired(meta: AttachmentMeta, now: number): boolean {
  return meta.deletedAt !== null || meta.expiresAt.getTime() <= now;
}

export function createAttachmentsService(deps: AttachmentsServiceDeps): AttachmentsService {
  const { store, conversations, clock } = deps;
  const sniffNow = deps.sniffClock ?? (() => performance.now());
  const onDeadline = (): void => deps.logger?.log(SNIFF_DEADLINE_LOG);
  return {
    async upload(uploaderId, conversationId, declared, bytes, filenameHeader, check) {
      // 형식은 내용으로만 판정한다. 선언 Content-Type은 판정 결과와 비교만 한다(TRD §6-1·§6-1-1).
      const sniffed = judge(declared, bytes, filenameHeader, sniffNow, onDeadline);
      const now = clock();
      const row = {
        id: randomUUID(),
        conversationId,
        uploaderId,
        mime: sniffed.mime,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        durationMs: sniffed.durationMs,
        width: sniffed.width,
        height: sniffed.height,
        filename: sniffed.filename,
        hasMacros: sniffed.hasMacros,
        createdAt: new Date(now),
        expiresAt: new Date(now + retentionMs(sniffed.mime)),
        bytes,
      };
      return check === undefined ? store.insert(row) : store.insert(row, check);
    },
    async resolveAccess(userId, attachmentId, action) {
      const meta = await store.get(attachmentId);
      if (meta === undefined) throw notFound();
      await conversations.assertAccess(userId, meta.conversationId, action);
      // 미결속 첨부는 업로더만(SR-D-04, 봇 경로와 같은 규칙). 다른 멤버에게는 없는 첨부와 같은 404로 존재를 숨긴다.
      if (meta.messageId === null && meta.uploaderId !== userId) throw notFound();
      return meta;
    },
    async read(meta) {
      if (isExpired(meta, clock())) throw notFound();
      const bytes = await store.bytes(meta.id);
      if (bytes === undefined) throw notFound();
      return { meta, bytes };
    },
    runRetention() {
      const now = clock();
      return store.retain(new Date(now), new Date(now - ATTACHMENT_UNBOUND_TTL_MS));
    },
  };
}

/** 보존 삭제 주기 실행(서버 타이머). 반환한 함수로 멈춘다(shutdown). 실행 중 예외는 로그 함수로만 넘기고 타이머는 유지한다. */
export function startRetentionTimer(service: AttachmentsService, intervalMs: number, onError: (error: unknown) => void): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    service
      .runRetention()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
