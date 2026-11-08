import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { BOT_ROUTE_PREFIX, markBotGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import type { BotMe } from '../../shared.js';
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

async function me(deps: BotRouteDeps, request: FastifyRequest): Promise<BotMe> {
  const botId = requireBot(request).botUserId;
  const found = await deps.bots.me(botId);
  if (found.ownerUserId === undefined) throw new HttpError(401, 'unauthenticated');
  return { id: botId, owner_user_id: found.ownerUserId, conversation_ids: [...found.conversationIds] };
}

/**
 * 등록 라우트(§5-2 6항, WS·첨부 제외). `POST /api/dms`·채널 참여·멤버 목록 같은 사람 전용 라우트는 등록하지 않는다(§5-2 5항).
 * 삭제(DELETE)도 §5-2 6항 목록에 없어 등록하지 않는다.
 */
export function registerBotRoutes(app: FastifyInstance, deps: BotRouteDeps): void {
  const p = BOT_ROUTE_PREFIX;
  const token = botTokenGuard(deps.bots);
  const config = { access: 'bot' as const };
  const guarded = (target: Target, action: AccessAction) => [token, accessGuard(deps, target, action)];

  app.get(`${p}me`, { config, preHandler: token }, (request) => me(deps, request));
  app.get(`${p}conversations/:id/messages`, { config, preHandler: guarded('conversation', 'read') }, (request) =>
    historyOf(deps.messages, pathId(request), request.query),
  );
  app.get(`${p}messages/:id/replies`, { config, preHandler: guarded('message', 'read') }, (request) =>
    repliesOf(deps.messages, pathId(request), request.query),
  );
  app.post(
    `${p}conversations/:id/messages`,
    { config, preHandler: [...guarded('conversation', 'write'), rateGuard(deps.limiter, 'create')] },
    (request, reply) => sendAs(deps.messages, requireBot(request).botUserId, pathId(request), request.body, reply),
  );
  app.patch(`${p}messages/:id`, { config, preHandler: [...guarded('message', 'write'), rateGuard(deps.limiter, 'edit')] }, (request) =>
    editAs(deps.messages, requireBot(request).botUserId, pathId(request), request.body),
  );
  app.get(`${p}sync`, { config, preHandler: token }, (request) => syncAs(deps.sync, requireBot(request).botUserId, request.query));
  app.get(`${p}sync/snapshot`, { config, preHandler: guarded('query', 'read') }, (request) => snapshotOf(deps.sync, request.query));
  app.put(`${p}read-state`, { config, preHandler: guarded('body', 'read') }, (request) =>
    markReadAs(deps.sync, requireBot(request).botUserId, request.body),
  );
}
