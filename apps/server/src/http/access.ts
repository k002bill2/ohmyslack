import type { FastifyInstance } from 'fastify';

/**
 * 접근 메타(정본: DEV_DESIGN §2-2 B2·B9, §2-4). `bot`(R3.3)은 봇 리스너 전용이다.
 * `attachment`(R3.3)는 W-21 소관이라 여기 아직 없다.
 */
export const ACCESS_KINDS = Object.freeze(['public', 'account', 'admin', 'conversation', 'message', 'bot'] as const);
export type Access = (typeof ACCESS_KINDS)[number];

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly access: Access;
  /** 표식 없는 `account` 라우트가 ACCOUNT_GUARD_EXEMPT로 통과했을 때만 true. */
  readonly guardExempt?: true;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
}

export class AccessMetaError extends Error {
  override readonly name = 'AccessMetaError';
}

/** `admin` 라우트 가드 표식. 레지스트리가 `admin` 메타 라우트의 preHandler에 이 표식이 있는지 강제한다. */
const ADMIN_GUARD = Symbol('oms.adminGuard');

export function markAdminGuard<T extends object>(guard: T): T {
  return Object.assign(guard, { [ADMIN_GUARD]: true });
}

/**
 * `conversation`·`message` 라우트 가드 표식. 표식은 `conversations.service.assertAccess`를 호출하는 가드에만 붙인다
 * (B2 단일 진입점). 레지스트리가 해당 메타 라우트의 preHandler에 이 표식이 있는지 강제한다.
 */
const CONVERSATION_GUARD = Symbol('oms.conversationGuard');

export function markConversationGuard<T extends object>(guard: T): T {
  return Object.assign(guard, { [CONVERSATION_GUARD]: true });
}

/** `account` 라우트 가드 표식(H-1). 세션 확인(+상태 변경이면 CSRF) 가드에만 붙인다. */
const ACCOUNT_GUARD = Symbol('oms.accountGuard');

export function markAccountGuard<T extends object>(guard: T): T {
  return Object.assign(guard, { [ACCOUNT_GUARD]: true });
}

/**
 * `bot` 라우트 가드 표식(B9, TRD §5-2). Bearer 봇 토큰 → 봇 계정 확인(`bots.verifyToken`) 가드에만 붙인다.
 * 레지스트리가 `bot` 메타 라우트의 preHandler에 이 표식이 있는지 강제한다. 실제 가드·라우트는 봇 리스너 레인(W-18b).
 */
const BOT_GUARD = Symbol('oms.botGuard');

export function markBotGuard<T extends object>(guard: T): T {
  return Object.assign(guard, { [BOT_GUARD]: true });
}

/** 레지스트리를 붙이는 리스너 종류. 메인(사람, Serve 대상)과 봇(루프백 별도 포트, B9)은 등록 가능한 메타가 다르다. */
export type ListenerKind = 'main' | 'bot';

/** 봇 리스너에 등록 가능한 경로 접두사(TRD §5-2 3항: `/api/bot/v1/**`만). */
export const BOT_ROUTE_PREFIX = '/api/bot/v1/';

/**
 * 표식 없이 등록이 허용되는 기존 `account` 라우트(정확한 `METHOD url`). 이 레인의 쓰기 경로 밖
 * (`modules/auth/**`·`conversations/routes.ts`·`realtime/**`)에서 가드를 만들기 때문에 표식을 붙일 수 없다.
 * 원천(`auth/guards.ts`의 accountGuard)에 표식을 붙이면 이 집합을 비운다 — 늘리지 않는다.
 * 테스트가 이 집합과 "실제로 표식 없이 등록된 account 라우트"가 정확히 같은지 단언한다.
 */
export const ACCOUNT_GUARD_EXEMPT: ReadonlySet<string> = Object.freeze(
  new Set([
    'POST /api/auth/logout',
    'GET /api/me',
    'HEAD /api/me',
    'GET /api/sessions',
    'HEAD /api/sessions',
    'GET /api/conversations',
    'HEAD /api/conversations',
    'GET /api/conversations/discover',
    'HEAD /api/conversations/discover',
    'POST /api/dms',
    'GET /api/ws',
    'HEAD /api/ws',
  ]),
);

function hasMarkedGuard(preHandler: unknown, mark: symbol): boolean {
  const handlers: unknown[] = Array.isArray(preHandler) ? preHandler : [preHandler];
  return handlers.some((h) => typeof h === 'function' && (h as unknown as Record<symbol, unknown>)[mark] === true);
}

/** WS 동작 표(B2). 처리기는 hub에서 `conversations.service.assertAccess`로만 판정한다(W-09b). */
export const WS_ACTIONS: readonly { readonly action: string; readonly access: Access }[] = Object.freeze([
  Object.freeze({ action: 'conversation.subscribe', access: 'conversation' as const }),
]);

function isAccess(value: unknown): value is Access {
  return typeof value === 'string' && (ACCESS_KINDS as readonly string[]).includes(value);
}

/** B9: 메인 리스너는 `bot` 메타를 받지 않고, 봇 리스너는 `/api/bot/v1/**`의 `bot` 메타만 받는다. */
function checkListener(listener: ListenerKind, access: Access, where: string, url: string): void {
  if (listener === 'main' && access === 'bot') {
    throw new AccessMetaError(`봇 라우트는 메인 리스너에 등록할 수 없습니다(B9): ${where}`);
  }
  if (listener === 'bot' && (access !== 'bot' || !url.startsWith(BOT_ROUTE_PREFIX))) {
    throw new AccessMetaError(`봇 리스너에는 ${BOT_ROUTE_PREFIX}** bot 메타 라우트만 등록합니다(B9): ${where}`);
  }
}

/** 메타별 가드 표식 검사. 표식 없는 `account`(예외 목록 통과)면 true를 돌려준다. */
function checkGuard(access: Access, preHandler: unknown, methods: readonly string[], url: string): boolean {
  const where = `${methods.join(',')} ${url}`;
  if (access === 'admin' && !hasMarkedGuard(preHandler, ADMIN_GUARD)) {
    throw new AccessMetaError(`admin 가드 누락: ${where}`);
  }
  if ((access === 'conversation' || access === 'message') && !hasMarkedGuard(preHandler, CONVERSATION_GUARD)) {
    throw new AccessMetaError(`대화 접근 가드 누락: ${where}`);
  }
  if (access === 'bot' && !hasMarkedGuard(preHandler, BOT_GUARD)) {
    throw new AccessMetaError(`봇 가드 누락: ${where}`);
  }
  const exempt = access === 'account' && !hasMarkedGuard(preHandler, ACCOUNT_GUARD);
  if (exempt && !methods.every((method) => ACCOUNT_GUARD_EXEMPT.has(`${method} ${url}`))) {
    throw new AccessMetaError(`account 가드 누락: ${where}`);
  }
  return exempt;
}

/**
 * `onRoute` 훅으로 등록되는 **모든** 라우트를 수집하고, `config.access`가 없거나 알 수 없는 값이면
 * 등록 자체를 throw로 막는다(기동 실패). `admin` 메타는 owner 가드(markAdminGuard)가, `conversation`·`message` 메타는
 * assertAccess 가드(markConversationGuard)가, `account` 메타는 세션 가드(markAccountGuard)가, `bot` 메타는 봇 토큰
 * 가드(markBotGuard)가 없어도 막는다(ACCOUNT_GUARD_EXEMPT 예외). 리스너 종류(기본 `main`)에 맞지 않는 메타도 막는다(B9).
 * 반환한 배열은 레지스트리 테스트가 읽는다.
 */
export function registerAccessRegistry(
  app: FastifyInstance,
  options: { readonly listener?: ListenerKind } = {},
): readonly RegisteredRoute[] {
  const listener = options.listener ?? 'main';
  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isAccess(access)) {
      throw new AccessMetaError(`access 메타 누락: ${methods.join(',')} ${route.url}`);
    }
    checkListener(listener, access, `${methods.join(',')} ${route.url}`, route.url);
    const exempt = checkGuard(access, route.preHandler, methods, route.url);
    for (const method of methods) {
      routes.push(Object.freeze({ method, url: route.url, access, ...(exempt ? { guardExempt: true as const } : {}) }));
    }
  });
  return routes;
}
