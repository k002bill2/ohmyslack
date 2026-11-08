import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../http/errors.js';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_RETENTION_DAYS, ATTACHMENT_UNBOUND_TTL_MS, isAttachmentMime } from '../../shared.js';
import type { AccessAction, ConversationsService } from '../conversations/service.js';
import type { AttachmentMeta, AttachmentsStore, RetentionResult } from './repo.js';
import { sniff } from './sniff.js';

/** 첨부 서비스(정본: TRD §6-1, DEV_DESIGN B10). 사람·봇 라우트가 같은 인스턴스를 쓴다(TRD §5-2 6항). */
export interface AttachmentsServiceDeps {
  readonly store: AttachmentsStore;
  readonly conversations: ConversationsService;
  readonly clock: () => number;
}

export interface Download {
  readonly meta: AttachmentMeta;
  readonly bytes: Buffer;
}

export interface AttachmentsService {
  /** 접근 판정은 호출자의 assertAccess 가드가 먼저 한다. 판정 실패는 415·413이며 저장 0. */
  upload(uploaderId: string, conversationId: string, declared: string, bytes: Buffer): Promise<AttachmentMeta>;
  /**
   * `attachment` 메타 라우트의 접근 판정(B2): 첨부 ID로 대화를 해석한 뒤 `conversations.service.assertAccess` **하나**로 판정한다.
   * 없는 첨부는 존재를 숨기고 404.
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
  return (mime.startsWith('audio/') ? ATTACHMENT_RETENTION_DAYS.audio : ATTACHMENT_RETENTION_DAYS.image) * DAY_MS;
}

export function isExpired(meta: AttachmentMeta, now: number): boolean {
  return meta.deletedAt !== null || meta.expiresAt.getTime() <= now;
}

export function createAttachmentsService(deps: AttachmentsServiceDeps): AttachmentsService {
  const { store, conversations, clock } = deps;
  return {
    async upload(uploaderId, conversationId, declared, bytes) {
      if (bytes.length > ATTACHMENT_MAX_BYTES) throw new HttpError(413, 'payload_too_large');
      if (bytes.length === 0) throw new HttpError(400, 'invalid_request');
      // 형식은 내용(매직 바이트)으로만 판정한다. 선언 Content-Type은 판정 결과와 같은지만 본다(다르면 415).
      const sniffed = sniff(bytes);
      if (sniffed === undefined || !isAttachmentMime(declared) || sniffed.mime !== declared) throw new HttpError(415, 'unsupported_media_type');
      const now = clock();
      return store.insert({
        id: randomUUID(),
        conversationId,
        uploaderId,
        mime: sniffed.mime,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        durationMs: sniffed.durationMs,
        width: sniffed.width,
        height: sniffed.height,
        createdAt: new Date(now),
        expiresAt: new Date(now + retentionMs(sniffed.mime)),
        bytes,
      });
    },
    async resolveAccess(userId, attachmentId, action) {
      const meta = await store.get(attachmentId);
      if (meta === undefined) throw notFound();
      await conversations.assertAccess(userId, meta.conversationId, action);
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
