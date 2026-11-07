import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccessRegistry, type RegisteredRoute } from './http/access.js';
import { errorBody, toHttpError } from './http/errors.js';
import { normalizeHost, registerRequestGuards, registerResponseHeaders } from './http/security.js';
import { createAuthEvents, type AuthEvents } from './modules/auth/events.js';
import { createLoginLimiter, type LoginLimiter } from './modules/auth/login-limiter.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import type { AuthStore } from './modules/auth/store.js';
import { createOpsLogger, type OpsLogger } from './modules/ops/logger.js';

export interface AppOptions {
  /** 정확한 허용 Origin(스킴·호스트·포트). 기본값은 골격 테스트용 `http://localhost`. */
  readonly allowedOrigin?: string;
  /** 추가 허용 Host. allowedOrigin의 host는 항상 포함된다. */
  readonly extraHosts?: readonly string[];
  /** 주어지지 않으면 인증 라우트를 등록하지 않는다(DB 없는 골격 테스트). */
  readonly authStore?: AuthStore;
  readonly clock?: () => number;
  readonly limiter?: LoginLimiter;
  readonly authEvents?: AuthEvents;
  readonly logger?: OpsLogger;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'allowedOrigin',
  'extraHosts',
  'authStore',
  'clock',
  'limiter',
  'authEvents',
  'logger',
]);

declare module 'fastify' {
  interface FastifyInstance {
    readonly accessRoutes: readonly RegisteredRoute[];
    readonly authEvents: AuthEvents;
  }
}

/** 알 수 없는 옵션(예: 쿠키 Secure 해제 시도)은 조용히 무시하지 않고 기동을 거부한다(NC-08). */
function checkOptions(options: AppOptions): string {
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`알 수 없는 앱 옵션: ${unknown.join(', ')}`);
  const origin = new URL(options.allowedOrigin ?? 'http://localhost');
  if (origin.origin !== (options.allowedOrigin ?? 'http://localhost')) throw new Error('allowedOrigin 형식 위반(경로·끝 / 없이)');
  return origin.origin;
}

function registerLogging(app: FastifyInstance, logger: OpsLogger, clock: () => number): void {
  app.addHook('onRequest', async (request) => {
    request.startedAt = clock();
  });
  app.addHook('onResponse', async (request, reply) => {
    logger.log({
      event: 'http_request',
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode,
      duration_ms: Math.max(0, clock() - (request.startedAt ?? clock())),
      request_id: request.id,
    });
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    startedAt?: number;
  }
}

/** 플러그인·라우트 조립 지점(정본: DEV_DESIGN §2-2, TRD §3·§5·§5-1). */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const allowedOrigin = checkOptions(options);
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? createOpsLogger();
  const authEvents = options.authEvents ?? createAuthEvents();
  const allowedHosts = [new URL(allowedOrigin).host, ...(options.extraHosts ?? [])].map((h) => normalizeHost(h) ?? '');

  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 64 * 1024 });
  const routes = registerAccessRegistry(app);
  app.decorate('accessRoutes', routes);
  app.decorate('authEvents', authEvents);
  registerLogging(app, logger, clock);
  registerRequestGuards(app, { allowedOrigin, allowedHosts });
  registerResponseHeaders(app);

  app.setErrorHandler((error, request, reply) => {
    const httpError = toHttpError(error);
    if (httpError.statusCode >= 500) logger.log({ event: 'http_error', request_id: request.id, error_code: httpError.code });
    return reply.code(httpError.statusCode).send(errorBody(request, httpError.code));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody(request, 'not_found')));

  app.register(cookie);
  app.get('/api/healthz', { config: { access: 'public' } }, async () => ({ status: 'ok' as const }));
  if (options.authStore !== undefined) {
    const store = options.authStore;
    const limiter = options.limiter ?? createLoginLimiter(clock);
    app.register(async (scope) => {
      registerAuthRoutes(scope, createAuthService({ store, limiter, events: authEvents, clock }));
    });
  }
  return app;
}
