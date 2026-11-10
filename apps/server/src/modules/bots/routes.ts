import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { BOT_ROUTE_PREFIX, markBotGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import { messageCreateRequestSchema, type BotMe, type HistoryResponse, type RepliesResponse, type SnapshotResponse, type SyncResponse } from '../../shared.js';
import { attachmentCspOnSend, attachmentPathId, downloadAs, registerUploadRoute, uploadAs, type AttachmentsService } from '../attachments/index.js';
import type { AccessAction, ConversationsService } from '../conversations/service.js';
import { editAs, historyOf, repliesOf, sendAs } from '../messages/routes.js';
import type { MessagesService } from '../messages/service.js';
import { conversationRefOf, markReadAs, snapshotOf, syncAs } from '../sync/routes.js';
import type { SyncService } from '../sync/service.js';
import type { BotRateKind, BotRateLimiter } from './rate-limit.js';
import type { BotService } from './service.js';

/** 봇 리스너 라우트(정본: TRD §5-2 5·6항, DEV_DESIGN B9). 사람 라우트와 같은 shared 스키마·서비스·assertAccess를 쓴다. */
export interface BotRouteDeps {
  readonly bots: BotService;
  readonly conversations: ConversationsService;
  readonly messages: MessagesService;
  readonly sync: SyncService;
  readonly limiter: BotRateLimiter;
  /** 있으면 첨부 라우트(§5-2 6항)를 등록한다. 사람 라우트와 같은 서비스 인스턴스. */
  readonly attachments?: AttachmentsService;
  readonly clock?: () => number;
}

/** 인증된 봇 컨텍스트. 사람 `request.auth`와 별개 필드다(세션·쿠키를 봇 인증에 쓰지 않는다). */
export interface BotContext {
  readonly botUserId: string;
  readonly tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    bot?: BotContext;
  }
}

const BEARER = /^Bearer ([^\s]+)$/;
const idParams = z.object({ id: z.uuid() });

export function requireBot(request: FastifyRequest): BotContext {
  if (request.bot === undefined) throw new HttpError(401, 'unauthenticated');
  return request.bot;
}

/** Bearer 봇 토큰 → verifyToken. 헤더 없음·형식 오류·미등록·폐기·비활성 봇은 모두 같은 401 본문. */
export function botTokenGuard(bots: BotService): preHandlerAsyncHookHandler {
  return markBotGuard(async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    const verified = match?.[1] === undefined ? undefined : await bots.verifyToken(match[1]);
    if (verified === undefined) throw new HttpError(401, 'unauthenticated');
    request.bot = Object.freeze({ botUserId: verified.botUserId, tokenId: verified.tokenId });
  });
}

/** 형식이 틀린 ID도 "없는 대상"과 같은 404다(존재 은폐). */
function pathId(request: FastifyRequest): string {
  const parsed = idParams.safeParse(request.params);
  if (!parsed.success) throw new HttpError(404, 'not_found');
  return parsed.data.id;
}

type Target = 'conversation' | 'message' | 'query' | 'body';

/** 대화 접근 가드: 대상 해석 → `assertAccess`(B2 단일 경계)에 봇 id로 판정. 비참여는 404. */
function accessGuard(deps: BotRouteDeps, target: Target, action: AccessAction): preHandlerAsyncHookHandler {
  return markBotGuard(async (request: FastifyRequest): Promise<void> => {
    const botId = requireBot(request).botUserId;
    if (target === 'message') {
      await deps.messages.resolveAccess(botId, pathId(request), action);
      return;
    }
    const id = target === 'conversation' ? pathId(request) : conversationRefOf(request, target);
    await deps.conversations.assertAccess(botId, id, action);
  });
}

/** 접근 판정 뒤, 저장 전에 토큰별 상한을 동기로 검사·기록한다. 초과는 429 + Retry-After(저장 0). */
function rateGuard(limiter: BotRateLimiter, kind: BotRateKind): preHandlerAsyncHookHandler {
  return markBotGuard(async (request, reply): Promise<void> => {
    const decision = limiter.take(requireBot(request).tokenId, kind);
    if (!decision.ok) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      throw new HttpError(429, 'rate_limited');
    }
  });
}

/** 첨부 업로드 상한(건수·바이트): 접근 판정 뒤, 저장 전에 본문 길이로 검사·기록한다. 초과는 429(저장 0). */
function uploadRateGuard(limiter: BotRateLimiter): preHandlerAsyncHookHandler {
  return markBotGuard(async (request, reply): Promise<void> => {
    const bytes = Buffer.isBuffer(request.body) ? request.body.length : 0;
    const decision = limiter.takeUpload(requireBot(request).tokenId, bytes);
    if (!decision.ok) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      throw new HttpError(429, 'rate_limited');
    }
  });
}

/** 봇 첨부 라우트: 사람 라우트와 같은 처리 본문(uploadAs·downloadAs)과 같은 assertAccess 경계. */
function registerBotAttachmentRoutes(app: FastifyInstance, deps: BotRouteDeps, attachments: AttachmentsService): void {
  const p = BOT_ROUTE_PREFIX;
  const token = botTokenGuard(deps.bots);
  const clock = deps.clock ?? Date.now;
  // 봇 가시성(§4-5 ⑦): 메시지에 묶인 첨부는 그 메시지 규칙, 미결합 첨부는 봇이 올린 것만.
  const attachmentAccess = markBotGuard(async (request: FastifyRequest): Promise<void> => {
    const botId = requireBot(request).botUserId;
    const meta = await attachments.resolveAccess(botId, attachmentPathId(request), 'read');
    const visible = meta.messageId === null ? meta.uploaderId === botId : (await deps.bots.visibleMessageIds(botId, [meta.messageId])).has(meta.messageId);
    if (!visible) throw new HttpError(404, 'not_found');
    request.attachmentAccess = meta;
  });
  registerUploadRoute(
    app,
    `${p}attachments`,
    { access: 'bot', preHandler: [token, accessGuard(deps, 'query', 'write'), uploadRateGuard(deps.limiter)] },
    (request, reply) => uploadAs(attachments, requireBot(request).botUserId, request, reply, clock),
  );
  app.get(`${p}attachments/:id`, { config: { access: 'bot' }, preHandler: [token, attachmentAccess], onSend: attachmentCspOnSend }, (request, reply) => {
    if (request.attachmentAccess === undefined) throw new HttpError(404, 'not_found');
    return downloadAs(attachments, request.attachmentAccess, request, reply);
  });
}

/**
 * 봇 답글 쓰기 차단(BOT_CHANNEL_SPEC §4-5, 영환님 ★ 2026-11-10): `thread_root_id`가 봇에게 보이지 않으면(참여 전 시작 스레드·없는 루트)
 * 같은 404다 — 존재 여부를 드러내지 않는다. 판정은 읽기 경로와 같은 `visibleMessageIds`. 형식 오류 본문은 `sendAs`의 400에 맡긴다.
 */
export async function assertReplyRootVisible(bots: Pick<BotService, 'visibleMessageIds'>, botId: string, rawBody: unknown): Promise<void> {
  const parsed = messageCreateRequestSchema.safeParse(rawBody);
  const rootId = parsed.success ? parsed.data.thread_root_id?.toLowerCase() : undefined;
  if (rootId === undefined || rootId === null) return;
  if (!(await bots.visibleMessageIds(botId, [rootId])).has(rootId)) throw new HttpError(404, 'not_found');
}

const threadRootGuard = (deps: BotRouteDeps): preHandlerAsyncHookHandler =>
  markBotGuard(async (request: FastifyRequest): Promise<void> => {
    await assertReplyRootVisible(deps.bots, requireBot(request).botUserId, request.body);
  });

/** 봇 가시성(BOT_CHANNEL_SPEC §4-5)으로 메시지 목록을 거른다. 페이지 커서·has_more는 원래 페이지 기준 그대로(건너뛰기만). */
async function visibleOnly<T extends { readonly id: string }>(deps: BotRouteDeps, botId: string, items: readonly T[]): Promise<T[]> {
  const visible = await deps.bots.visibleMessageIds(botId, items.map((m) => m.id));
  return items.filter((m) => visible.has(m.id));
}

/**
 * 숨김 원문은 항상 seq ≤ joined_seq인 앞부분이다(이력은 원문만). after_seq 방향은 숨김만 있는 페이지를 서버가 건너뛰고(Codex P2),
 * 그 밖의 방향에서 거른 결과가 비면 더 오래된 쪽도 전부 숨김이므로 has_more=false로 끝낸다.
 */
async function botHistory(deps: BotRouteDeps, request: FastifyRequest): Promise<HistoryResponse> {
  const botId = requireBot(request).botUserId;
  const conversationId = pathId(request);
  let query = request.query as Record<string, unknown>;
  for (;;) {
    const page = await historyOf(deps.messages, conversationId, query);
    const messages = await visibleOnly(deps, botId, page.messages);
    const last = page.messages.at(-1);
    if (messages.length > 0 || !page.has_more || last === undefined) return { ...page, messages };
    if (query.after_seq === undefined) return { messages: [], has_more: false };
    query = { ...query, after_seq: String(last.seq) };
  }
}

/** 루트가 봇에게 보이지 않으면(참여 전 시작 스레드) 404 — 숨김 루트 표현을 새로 만들지 않는다. */
async function botReplies(deps: BotRouteDeps, request: FastifyRequest): Promise<RepliesResponse> {
  const rootId = pathId(request).toLowerCase();
  const botId = requireBot(request).botUserId;
  if (!(await deps.bots.visibleMessageIds(botId, [rootId])).has(rootId)) throw new HttpError(404, 'not_found');
  return repliesOf(deps.messages, rootId, request.query);
}

async function botSnapshot(deps: BotRouteDeps, request: FastifyRequest): Promise<SnapshotResponse> {
  const page = await snapshotOf(deps.sync, request.query);
  return { ...page, messages: await visibleOnly(deps, requireBot(request).botUserId, page.messages) };
}

async function botSync(deps: BotRouteDeps, request: FastifyRequest): Promise<SyncResponse> {
  const botId = requireBot(request).botUserId;
  const page = await syncAs(deps.sync, botId, request.query);
  const visible = await deps.bots.visibleMessageIds(botId, page.changes.map((c) => c.message.id));
  return { ...page, changes: page.changes.filter((c) => visible.has(c.message.id)) };
}

/** `/me` projection: `conversation_ids`는 호환 유지, `conversations`(종류)·`display_name`을 더한다(BOT_CHANNEL_SPEC §4-4). */
export function toBotMe(botId: string, found: Awaited<ReturnType<BotService['me']>>): BotMe {
  if (found.ownerUserId === undefined) throw new HttpError(401, 'unauthenticated');
  return {
    id: botId,
    owner_user_id: found.ownerUserId,
    display_name: found.displayName,
    conversation_ids: found.conversations.map((c) => c.id),
    conversations: found.conversations.map((c) => ({ id: c.id, kind: c.kind })),
  };
}

async function me(deps: BotRouteDeps, request: FastifyRequest): Promise<BotMe> {
  const botId = requireBot(request).botUserId;
  return toBotMe(botId, await deps.bots.me(botId));
}

/**
 * 등록 라우트(§5-2 6항, WS 제외 — 첨부는 서비스가 주어졌을 때). `POST /api/dms`·채널 참여·멤버 목록 같은 사람 전용 라우트는 등록하지 않는다(§5-2 5항).
 * 삭제(DELETE)도 §5-2 6항 목록에 없어 등록하지 않는다.
 */
export function registerBotRoutes(app: FastifyInstance, deps: BotRouteDeps): void {
  const p = BOT_ROUTE_PREFIX;
  const token = botTokenGuard(deps.bots);
  const config = { access: 'bot' as const };
  const guarded = (target: Target, action: AccessAction) => [token, accessGuard(deps, target, action)];

  app.get(`${p}me`, { config, preHandler: token }, (request) => me(deps, request));
  app.get(`${p}conversations/:id/messages`, { config, preHandler: guarded('conversation', 'read') }, (request) => botHistory(deps, request));
  app.get(`${p}messages/:id/replies`, { config, preHandler: guarded('message', 'read') }, (request) => botReplies(deps, request));
  app.post(
    `${p}conversations/:id/messages`,
    { config, preHandler: [...guarded('conversation', 'write'), threadRootGuard(deps), rateGuard(deps.limiter, 'create')] },
    (request, reply) => sendAs(deps.messages, requireBot(request).botUserId, pathId(request), request.body, reply),
  );
  app.patch(`${p}messages/:id`, { config, preHandler: [...guarded('message', 'write'), rateGuard(deps.limiter, 'edit')] }, (request) =>
    editAs(deps.messages, requireBot(request).botUserId, pathId(request), request.body),
  );
  app.get(`${p}sync`, { config, preHandler: token }, (request) => botSync(deps, request));
  app.get(`${p}sync/snapshot`, { config, preHandler: guarded('query', 'read') }, (request) => botSnapshot(deps, request));
  app.put(`${p}read-state`, { config, preHandler: guarded('body', 'read') }, (request) =>
    markReadAs(deps.sync, requireBot(request).botUserId, request.body),
  );
  if (deps.attachments !== undefined) registerBotAttachmentRoutes(app, deps, deps.attachments);
}
