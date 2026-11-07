import type { FastifyInstance } from 'fastify';

/** 접근 메타(정본: DEV_DESIGN §2-2 B2, §2-4). */
export const ACCESS_KINDS = Object.freeze(['public', 'account', 'admin', 'conversation', 'message'] as const);
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

/**
 * `onRoute` 훅으로 등록되는 **모든** 라우트를 수집하고, `config.access`가 없거나 알 수 없는 값이면
 * 등록 자체를 throw로 막는다(기동 실패). `admin` 메타는 owner 가드(markAdminGuard)가, `conversation`·`message` 메타는
 * assertAccess 가드(markConversationGuard)가, `account` 메타는 세션 가드(markAccountGuard)가 없어도 막는다
 * (ACCOUNT_GUARD_EXEMPT 예외). 반환한 배열은 레지스트리 테스트가 읽는다.
 */
export function registerAccessRegistry(app: FastifyInstance): readonly RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isAccess(access)) {
      throw new AccessMetaError(`access 메타 누락: ${methods.join(',')} ${route.url}`);
    }
    if (access === 'admin' && !hasMarkedGuard(route.preHandler, ADMIN_GUARD)) {
      throw new AccessMetaError(`admin 가드 누락: ${methods.join(',')} ${route.url}`);
    }
    if ((access === 'conversation' || access === 'message') && !hasMarkedGuard(route.preHandler, CONVERSATION_GUARD)) {
      throw new AccessMetaError(`대화 접근 가드 누락: ${methods.join(',')} ${route.url}`);
    }
    const exempt = access === 'account' && !hasMarkedGuard(route.preHandler, ACCOUNT_GUARD);
    if (exempt && !methods.every((method) => ACCOUNT_GUARD_EXEMPT.has(`${method} ${route.url}`))) {
      throw new AccessMetaError(`account 가드 누락: ${methods.join(',')} ${route.url}`);
    }
    for (const method of methods) {
      routes.push(Object.freeze({ method, url: route.url, access, ...(exempt ? { guardExempt: true as const } : {}) }));
    }
  });
  return routes;
}
