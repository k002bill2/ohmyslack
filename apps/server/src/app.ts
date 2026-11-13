import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccessRegistry, type RegisteredRoute } from './http/access.js';
import { errorBody, toHttpError } from './http/errors.js';
import { frameworkErrorHandler, normalizeHost, registerRequestGuards, registerResponseHeaders } from './http/security.js';
import { createAuthEvents, type AuthEvents } from './modules/auth/events.js';
import { createLoginLimiter, type LoginLimiter } from './modules/auth/login-limiter.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { createAuthService, primeDummyHash } from './modules/auth/service.js';
import type { AuthStore } from './modules/auth/store.js';
import { createConversationEvents, type ConversationEvents } from './modules/conversations/events.js';
import { registerConversationRoutes } from './modules/conversations/routes.js';
import { createConversationsService, type ConversationsService } from './modules/conversations/service.js';
import type { ConversationsStore } from './modules/conversations/store.js';
import { createAttachmentsService, registerAttachmentRoutes, type AttachmentsService, type AttachmentsStore } from './modules/attachments/index.js';
import { createMessageEvents, type MessageEvents } from './modules/messages/events.js';
import { registerMessageRoutes } from './modules/messages/routes.js';
import { createMessagesService, type MessagesService } from './modules/messages/service.js';
import type { MessagesStore } from './modules/messages/store.js';
import { registerMemberRoutes } from './modules/members/routes.js';
import type { MembersStore } from './modules/members/store.js';
import { createReadEvents, type ReadEvents } from './modules/sync/events.js';
import { registerSyncRoutes } from './modules/sync/routes.js';
import { createSyncService, type SyncService } from './modules/sync/service.js';
import type { SyncStore } from './modules/sync/store.js';
import { createOpsLogger, type OpsLogger } from './modules/ops/logger.js';
import { createPushService, registerPushRoutes, type PushOptions, type PushService, type PushStore } from './modules/push/index.js';
import { registerRealtime, type RealtimeOptions } from './modules/realtime/index.js';
import { registerStatic } from './static/index.js';

export interface AppOptions {
  /** 정확한 허용 Origin(스킴·호스트·포트). 기본값은 골격 테스트용 `http://localhost`. */
  readonly allowedOrigin?: string;
  /** 추가 허용 Host. allowedOrigin의 host는 항상 포함된다. */
  readonly extraHosts?: readonly string[];
  /** 주어지지 않으면 인증 라우트를 등록하지 않는다(DB 없는 골격 테스트). */
  readonly authStore?: AuthStore;
  /** 초대·멤버·비활성화 저장소. authStore와 함께 주어질 때만 해당 라우트를 등록한다. */
  readonly membersStore?: MembersStore;
  /** 대화 공간 저장소. authStore와 함께 주어질 때만 대화 라우트를 등록한다. */
  readonly conversationsStore?: ConversationsStore;
  readonly conversationEvents?: ConversationEvents;
  /** 메시지 저장소. conversationsStore와 함께 주어질 때만 메시지 라우트를 등록한다. */
  readonly messagesStore?: MessagesStore;
  readonly messageEvents?: MessageEvents;
  /** sync·읽음 저장소. messagesStore와 함께 주어질 때만 sync·read-state 라우트를 등록한다. */
  readonly syncStore?: SyncStore;
  readonly readEvents?: ReadEvents;
  /** 첨부 저장소(TRD §6-1). messagesStore와 함께 주어질 때만 첨부 라우트를 등록한다. */
  readonly attachmentsStore?: AttachmentsStore;
  /** Web Push 구독 저장소(TRD §6-2). authStore와 함께 주어질 때만 push 라우트·전송을 켠다. */
  readonly pushStore?: PushStore;
  /** VAPID 설정·전송 함수·예약 주입. config가 없으면 push 비활성(라우트 404). */
  readonly push?: PushOptions;
  readonly clock?: () => number;
  readonly limiter?: LoginLimiter;
  readonly authEvents?: AuthEvents;
  readonly logger?: OpsLogger;
  /** WS 설정 주입(heartbeat 등). syncStore가 있을 때 `/api/ws`를 등록한다. */
  readonly realtime?: RealtimeOptions;
  /** 웹 빌드 산출물 디렉터리(절대 경로). 주어지면 같은 출처로 정적 셸·SPA fallback을 서빙한다(TRD §6). */
  readonly webDistDir?: string;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'allowedOrigin',
  'extraHosts',
  'authStore',
  'membersStore',
  'conversationsStore',
  'conversationEvents',
  'messagesStore',
  'messageEvents',
  'syncStore',
  'readEvents',
  'attachmentsStore',
  'pushStore',
  'push',
  'clock',
  'limiter',
  'authEvents',
  'logger',
  'realtime',
  'webDistDir',
]);

declare module 'fastify' {
  interface FastifyInstance {
    readonly accessRoutes: readonly RegisteredRoute[];
    readonly authEvents: AuthEvents;
    readonly conversationEvents: ConversationEvents;
    readonly messageEvents: MessageEvents;
    readonly readEvents: ReadEvents;
    /** 대화·메시지·sync 서비스(저장소가 모두 주어졌을 때만). 봇 리스너가 같은 인스턴스를 공유한다(TRD §5-2 6항). */
    readonly domainServices: DomainServices | undefined;
    /** push 서비스(pushStore·authStore가 주어졌을 때만). */
    readonly pushService: PushService | undefined;
  }
}

export interface DomainServices {
  readonly conversations: ConversationsService;
  readonly messages: MessagesService;
  readonly sync: SyncService;
  /** 첨부 서비스(attachmentsStore가 주어졌을 때만). 봇 첨부 라우트가 같은 인스턴스를 쓴다. */
  readonly attachments?: AttachmentsService;
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
  const conversationEvents = options.conversationEvents ?? createConversationEvents();
  const messageEvents = options.messageEvents ?? createMessageEvents();
  const readEvents = options.readEvents ?? createReadEvents();
  const allowedHosts = [new URL(allowedOrigin).host, ...(options.extraHosts ?? [])].map((h) => normalizeHost(h) ?? '');

  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    frameworkErrors: frameworkErrorHandler(allowedHosts),
  });
  const routes = registerAccessRegistry(app);
  app.decorate('accessRoutes', routes);
  app.decorate('authEvents', authEvents);
  app.decorate('conversationEvents', conversationEvents);
  app.decorate('messageEvents', messageEvents);
  app.decorate('readEvents', readEvents);
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
  const webDistDir = options.webDistDir;
  if (webDistDir !== undefined) app.register(async (scope) => registerStatic(scope, webDistDir));
  const conversations =
    options.conversationsStore === undefined
      ? undefined
      : createConversationsService({ store: options.conversationsStore, events: conversationEvents, clock });
  const messages =
    conversations === undefined || options.messagesStore === undefined
      ? undefined
      : createMessagesService({ store: options.messagesStore, conversations, events: messageEvents, clock });
  const sync =
    messages === undefined || options.syncStore === undefined ? undefined : createSyncService({ store: options.syncStore, events: readEvents, clock });
  const attachments =
    messages === undefined || conversations === undefined || options.attachmentsStore === undefined
      ? undefined
      : createAttachmentsService({ store: options.attachmentsStore, conversations, clock, logger });
  app.decorate(
    'domainServices',
    options.authStore === undefined || conversations === undefined || messages === undefined || sync === undefined
      ? undefined
      : Object.freeze({ conversations, messages, sync, ...(attachments === undefined ? {} : { attachments }) }),
  );
  const push =
    options.authStore === undefined || options.pushStore === undefined
      ? undefined
      : createPushService({ store: options.pushStore, logger, clock, ...options.push });
  app.decorate('pushService', push);
  if (push !== undefined) {
    // 커밋 후 이벤트에서 예약만 한다(메시지 생성 경로는 전송을 기다리지 않는다). 세션 폐기 시 그 기기의 구독을 지운다.
    messageEvents.on('created', (event) => push.onMessageCreated(event));
    authEvents.onSessionRevoked((ids) => push.onSessionsRevoked(ids));
    app.addHook('onClose', async () => push.idle());
  }
  if (options.authStore !== undefined) {
    const store = options.authStore;
    const limiter = options.limiter ?? createLoginLimiter(clock);
    const membersStore = options.membersStore;
    const syncStore = options.syncStore;
    app.register(async (scope) => {
      // 더미 해시를 준비 단계에서 선계산해 첫 로그인의 미존재 계정 응답 시간이 튀지 않게 한다(NC-17).
      await primeDummyHash();
      const auth = createAuthService({ store, limiter, events: authEvents, clock });
      registerAuthRoutes(scope, auth);
      if (push !== undefined) registerPushRoutes(scope, { auth, push });
      if (membersStore !== undefined) registerMemberRoutes(scope, { auth, store: membersStore, events: authEvents, clock });
      if (conversations !== undefined) {
        registerConversationRoutes(scope, { auth, conversations });
        if (messages !== undefined) {
          registerMessageRoutes(scope, { auth, conversations, messages });
          if (attachments !== undefined) registerAttachmentRoutes(scope, { auth, conversations, attachments, clock });
          if (sync !== undefined && syncStore !== undefined) {
            registerSyncRoutes(scope, { auth, conversations, sync });
            const deps = { auth, conversations, syncStore, authEvents, conversationEvents, messageEvents, readEvents, clock };
            await registerRealtime(scope, { ...deps, allowedOrigin, ...(options.realtime === undefined ? {} : { options: options.realtime }) });
          }
        }
      }
    });
  }
  return app;
}
