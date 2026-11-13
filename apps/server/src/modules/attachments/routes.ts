import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestAsyncHookHandler, preHandlerAsyncHookHandler, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import { markAccountGuard, markConversationGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import {
  ATTACHMENT_DOC_MAX_BYTES,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_HUMAN_CONCURRENT_UPLOADS,
  attachmentUploadQuerySchema,
  isAttachmentFileMime,
  type AttachmentUploadResponse,
  type AttachmentView,
} from '../../shared.js';
import { accountGuard, requireAuth } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { ConversationsService } from '../conversations/service.js';
import { conversationRefGuard } from '../sync/routes.js';
import type { AttachmentMeta } from './repo.js';
import { isExpired, type AttachmentsService } from './service.js';
import { attachmentDisposition } from './filename.js';
import { declaredType } from './sniff.js';

/** 첨부 라우트(정본: TRD §3 attachments 행, §6-1, DEV_DESIGN 2-4 `attachment` 행). 사람·봇 라우트가 아래 처리 본문을 공유한다. */
export interface AttachmentRouteDeps {
  readonly auth: AuthService;
  readonly conversations: ConversationsService;
  readonly attachments: AttachmentsService;
  readonly clock: () => number;
}

const idParams = z.object({ id: z.uuid() });

/** 형식이 틀린 ID도 "없는 대상"과 같은 404다(존재 은폐). */
export function attachmentPathId(request: FastifyRequest): string {
  const parsed = idParams.safeParse(request.params);
  if (!parsed.success) throw new HttpError(404, 'not_found');
  return parsed.data.id;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** `attachment` 메타 가드가 해석·판정한 첨부(처리기가 다시 조회하지 않는다). */
    attachmentAccess?: AttachmentMeta;
  }
}

/** 다운로드 응답 CSP(TRD §6-1·§5-1 S6): 전역 S6 CSP를 이 응답에서만 대체한다. */
export const ATTACHMENT_CSP = "sandbox; default-src 'none'";

export function toAttachmentView(meta: AttachmentMeta, now: number): AttachmentView {
  return {
    id: meta.id,
    mime: meta.mime,
    byte_size: meta.byteSize,
    duration_ms: meta.durationMs,
    width: meta.width,
    height: meta.height,
    ...(isAttachmentFileMime(meta.mime) ? { filename: meta.filename, has_macros: meta.hasMacros } : {}),
    expires_at: meta.expiresAt.toISOString(),
    expired: isExpired(meta, now),
  };
}

/** 업로드 처리 본문(사람·봇 공용). 대화 write 접근은 호출자의 assertAccess 가드가 먼저 판정한다. */
export async function uploadAs(
  service: AttachmentsService,
  uploaderId: string,
  request: FastifyRequest,
  reply: FastifyReply,
  now: () => number,
): Promise<AttachmentUploadResponse> {
  const query = attachmentUploadQuerySchema.safeParse(request.query);
  if (!query.success) throw new HttpError(400, 'invalid_request');
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const rawName = request.headers[ATTACHMENT_FILENAME_HEADER];
  if (Array.isArray(rawName)) throw new HttpError(400, 'invalid_request');
  const meta = await service.upload(uploaderId, query.data.conversation_id, declaredType(request.headers['content-type']), body, rawName);
  reply.code(201);
  return { attachment_id: meta.id, attachment: toAttachmentView(meta, now()) };
}

type ByteRange = { readonly start: number; readonly end: number } | 'full' | 'unsatisfiable';

/**
 * 단일 범위만 206으로 처리한다(iOS 오디오 재생, TRD §6-1). 다중 범위·문법 오류는 Range를 무시하고 전체 200
 * (RFC 9110 §14.2: 서버는 Range를 무시할 수 있다). 문법은 맞지만 시작이 크기 이상이면 416.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return 'full';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return 'full';
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return 'full';
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (rawEnd !== '' && Number(rawEnd) < start) return 'full';
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

/** 다운로드 처리 본문(사람·봇 공용). 첨부는 가드가 해석·판정해 둔 것을 쓴다. */
export async function downloadAs(service: AttachmentsService, meta: AttachmentMeta, request: FastifyRequest, reply: FastifyReply): Promise<Buffer | undefined> {
  const { bytes } = await service.read(meta);
  // 문서·텍스트 계열은 `attachment` + RFC 6266/5987 파일명, 미디어는 기존 `inline`(TRD §6-1-1 (6)).
  const file = isAttachmentFileMime(meta.mime);
  reply
    .header('content-type', file && meta.mime.startsWith('text/') ? `${meta.mime}; charset=utf-8` : meta.mime)
    .header('content-disposition', file ? attachmentDisposition(meta.filename ?? 'document') : 'inline')
    .header('accept-ranges', 'bytes')
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff');
  const range = parseRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, bytes.length);
  if (range === 'unsatisfiable') {
    reply.code(416).header('content-range', `bytes */${bytes.length}`);
    return undefined;
  }
  if (range === 'full') return bytes;
  reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`);
  return bytes.subarray(range.start, range.end + 1);
}

/** 전역 onSend(S6 CSP)보다 **뒤**에 도는 라우트 onSend로 첨부 응답 CSP를 sandbox로 바꾼다. */
export async function attachmentCspOnSend(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  reply.header('content-security-policy', ATTACHMENT_CSP);
  return payload;
}

/**
 * 업로드 라우트는 별도 캡슐 범위에 등록한다: 이 범위에서만 원시 바이트 파서(모든 Content-Type → Buffer)와 25 MiB body 상한을 쓴다.
 * 전역 64 KiB 상한·JSON 파서는 다른 라우트에 그대로 남는다(TRD §6-1-1 (4) "업로드 라우트 body 상한 26,214,400").
 */
export function registerUploadRoute(
  app: FastifyInstance,
  url: string,
  options: { readonly access: 'account' | 'bot'; readonly preHandler: preHandlerAsyncHookHandler[]; readonly onRequest?: onRequestAsyncHookHandler[] },
  handler: RouteHandlerMethod,
): void {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: ATTACHMENT_DOC_MAX_BYTES }, (_request, body, done) => done(null, body));
    scope.post(
      url,
      { config: { access: options.access }, bodyLimit: ATTACHMENT_DOC_MAX_BYTES, onRequest: options.onRequest ?? [], preHandler: options.preHandler },
      handler,
    );
  });
}

/**
 * 사람 계정 동시 업로드 상한(TRD §6-1-1 (2) ★, 초과 429). body를 버퍼에 쌓기 **전**(onRequest)에 세션을 확인하고 자리를 잡는다.
 * 자리는 응답 소켓이 닫힐 때(정상·중단 모두) 돌려준다. 메모리 상태(단일 프로세스).
 */
export function concurrentUploadGuard(auth: AuthService, max: number = ATTACHMENT_HUMAN_CONCURRENT_UPLOADS): onRequestAsyncHookHandler {
  const active = new Map<string, number>();
  const authenticate = accountGuard(auth);
  return async (request, reply) => {
    await authenticate.call(request.server, request, reply);
    const userId = requireAuth(request).user.id;
    const used = active.get(userId) ?? 0;
    if (used >= max) throw new HttpError(429, 'rate_limited');
    active.set(userId, used + 1);
    let released = false;
    reply.raw.once('close', () => {
      if (released) return;
      released = true;
      const left = (active.get(userId) ?? 1) - 1;
      if (left <= 0) active.delete(userId);
      else active.set(userId, left);
    });
  };
}

/** `attachment` 메타 가드: 첨부 ID → 대화 해석 → assertAccess(read) 하나(B2). 표식이 없으면 레지스트리가 등록을 거부한다. */
export function attachmentGuard(service: AttachmentsService): preHandlerAsyncHookHandler {
  return markConversationGuard(async (request: FastifyRequest): Promise<void> => {
    request.attachmentAccess = await service.resolveAccess(requireAuth(request).user.id, attachmentPathId(request), 'read');
  });
}

function guarded(request: FastifyRequest): AttachmentMeta {
  if (request.attachmentAccess === undefined) throw new HttpError(404, 'not_found');
  return request.attachmentAccess;
}

/**
 * 사람 라우트. 업로드는 URL이 경로 변수 없이 고정(`?conversation_id=`)이라 snapshot·read-state와 같은 `account` 메타 + 표식 붙은
 * assertAccess(write) 가드다. 다운로드는 `attachment` 메타(DEV_DESIGN 2-4).
 */
export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  const account = markAccountGuard(accountGuard(deps.auth));
  registerUploadRoute(
    app,
    '/api/attachments',
    { access: 'account', onRequest: [concurrentUploadGuard(deps.auth)], preHandler: [account, conversationRefGuard(deps.conversations, 'query', 'write')] },
    (request, reply) => uploadAs(deps.attachments, requireAuth(request).user.id, request, reply, deps.clock),
  );
  app.get(
    '/api/attachments/:id',
    { config: { access: 'attachment' }, preHandler: [account, attachmentGuard(deps.attachments)], onSend: attachmentCspOnSend },
    (request, reply) => downloadAs(deps.attachments, guarded(request), request, reply),
  );
}
