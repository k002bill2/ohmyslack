import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { listenLoopback, parsePort } from '../../bind.js';
import { registerAccessRegistry, type RegisteredRoute } from '../../http/access.js';
import { errorBody, sendError, toHttpError } from '../../http/errors.js';
import { normalizeHost, registerResponseHeaders } from '../../http/security.js';
import type { ConversationsService } from '../conversations/service.js';
import type { MessagesService } from '../messages/service.js';
import type { OpsLogger } from '../ops/logger.js';
import type { SyncService } from '../sync/service.js';
import { createBotRateLimiter, type BotRateLimiter } from './rate-limit.js';
import { registerBotRoutes } from './routes.js';
import type { BotService } from './service.js';
import { registerBotRealtime, type BotRealtimeDeps } from './ws.js';

/**
 * 봇 리스너(정본: TRD §5-2 3·4항, DEV_DESIGN B9). 메인과 **별도** Fastify 인스턴스로, `127.0.0.1:<BOT_PORT>`에만 바인드한다.
 * 메인의 전역 보안 훅(Origin·CSRF)과 쿠키 플러그인은 붙이지 않는다. 대신 Origin 또는 Cookie 헤더가 있으면 400(브라우저발 차단).
 */
export interface BotAppOptions {
  readonly bots: BotService;
  readonly conversations: ConversationsService;
  readonly messages: MessagesService;
  readonly sync: SyncService;
  readonly logger: OpsLogger;
  readonly clock?: () => number;
  readonly limiter?: BotRateLimiter;
  /** Host 허용목록의 포트. 생략하면 실제 바인드 포트(listen 전에는 모든 Host 거부). */
  readonly port?: number;
  /** 있으면 봇 WS(`/api/bot/v1/ws`)를 등록한다. 메인 앱과 같은 이벤트 인스턴스여야 한다. */
  readonly realtime?: BotRealtimeDeps;
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly botAccessRoutes?: readonly RegisteredRoute[];
  }
}

function headerPresent(request: FastifyRequest, name: string): boolean {
  return request.headers[name] !== undefined;
}

export function boundPort(app: FastifyInstance, fixed: number | undefined): number | undefined {
  if (fixed !== undefined) return fixed;
  const address: AddressInfo | string | null = app.server.address();
  return address !== null && typeof address !== 'string' ? address.port : undefined;
}

/** Host 허용목록(127.0.0.1·localhost + 봇 포트) → Origin/Cookie 동봉 거부. 인증(Bearer)은 라우트 가드가 한다. */
function registerBotRequestGuards(app: FastifyInstance, fixedPort: number | undefined): void {
  app.addHook('onRequest', async (request, reply) => {
    const port = boundPort(app, fixedPort);
    const host = normalizeHost(typeof request.headers.host === 'string' ? request.headers.host : undefined);
    // 허용목록도 같은 정규화를 거친다(BOT_PORT=80이면 기본 포트가 제거된 `127.0.0.1`과 비교, Codex r1 P2).
    const allowed = port === undefined ? [] : [normalizeHost(`127.0.0.1:${port}`), normalizeHost(`localhost:${port}`)];
    if (host === undefined || !allowed.includes(host)) {
      return sendError(request, reply, 400, 'host_not_allowed');
    }
    if (headerPresent(request, 'origin') || headerPresent(request, 'cookie')) return sendError(request, reply, 400, 'browser_request_rejected');
    return undefined;
  });
  // 업그레이드 요청을 위 가드·봇 가드(401)·404가 일반 응답으로 끝내면 raw 소켓이 남는다 — 메인 security.ts(W-09b P3)와 같은 처리.
  // 업그레이드에 성공한 요청은 hijack되어 onResponse가 돌지 않는다.
  app.addHook('onResponse', async (request: FastifyRequest) => {
    if ((request.raw as { readonly upgrade?: boolean }).upgrade === true) request.raw.socket.destroy();
  });
}

export function buildBotApp(options: BotAppOptions): FastifyInstance {
  const clock = options.clock ?? Date.now;
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    frameworkErrors: (_error, request, reply) => {
      void sendError(request, reply, 400, 'invalid_request');
    },
  });
  app.decorate('botAccessRoutes', registerAccessRegistry(app, { listener: 'bot' }));
  registerBotRequestGuards(app, options.port);
  registerResponseHeaders(app);
  app.addHook('onResponse', async (request, reply) => {
    options.logger.log({
      event: 'http_request',
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode,
      request_id: request.id,
    });
  });
  app.setErrorHandler((error, request, reply) => {
    const httpError = toHttpError(error);
    if (httpError.statusCode >= 500) options.logger.log({ event: 'http_error', request_id: request.id, error_code: httpError.code });
    return reply.code(httpError.statusCode).send(errorBody(request, httpError.code));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody(request, 'not_found')));
  registerBotRoutes(app, {
    bots: options.bots,
    conversations: options.conversations,
    messages: options.messages,
    sync: options.sync,
    limiter: options.limiter ?? createBotRateLimiter(clock),
  });
  if (options.realtime !== undefined) {
    registerBotRealtime(app, { bots: options.bots, conversations: options.conversations, clock, realtime: options.realtime });
  }
  return app;
}

/** `BOT_PORT`: 미설정·빈 값이면 undefined(봇 리스너 꺼짐 — 기본값 없음). 형식 오류·메인 PORT와 같으면 기동 거부. */
export function resolveBotPort(env: Readonly<Record<string, string | undefined>>, mainPort: number): number | undefined {
  const raw = env.BOT_PORT;
  if (raw === undefined || raw === '') return undefined;
  const port = parsePort(raw);
  if (port === mainPort) throw new Error('BOT_PORT는 PORT와 달라야 합니다');
  return port;
}

/** 메인과 같은 루프백 바인드 가드(HOST 검사 → listen → 실제 주소 확인)로 연다. */
export function listenBot(app: FastifyInstance, env: Readonly<Record<string, string | undefined>>, port: number): Promise<AddressInfo> {
  return listenLoopback(app, env, port);
}
