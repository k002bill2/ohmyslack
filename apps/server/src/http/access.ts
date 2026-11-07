import type { FastifyInstance } from 'fastify';

/** 접근 메타(정본: DEV_DESIGN §2-2 B2, §2-4). */
export const ACCESS_KINDS = Object.freeze(['public', 'account', 'admin', 'conversation', 'message'] as const);
export type Access = (typeof ACCESS_KINDS)[number];

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly access: Access;
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

function hasAdminGuard(preHandler: unknown): boolean {
  const handlers: unknown[] = Array.isArray(preHandler) ? preHandler : [preHandler];
  return handlers.some((h) => typeof h === 'function' && (h as unknown as Record<symbol, unknown>)[ADMIN_GUARD] === true);
}

function isAccess(value: unknown): value is Access {
  return typeof value === 'string' && (ACCESS_KINDS as readonly string[]).includes(value);
}

/**
 * `onRoute` 훅으로 등록되는 **모든** 라우트를 수집하고, `config.access`가 없거나 알 수 없는 값이면
 * 등록 자체를 throw로 막는다(기동 실패). `admin` 메타는 owner 가드(markAdminGuard)가 없어도 막는다. 반환한 배열은 레지스트리 테스트가 읽는다.
 */
export function registerAccessRegistry(app: FastifyInstance): readonly RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isAccess(access)) {
      throw new AccessMetaError(`access 메타 누락: ${methods.join(',')} ${route.url}`);
    }
    if (access === 'admin' && !hasAdminGuard(route.preHandler)) {
      throw new AccessMetaError(`admin 가드 누락: ${methods.join(',')} ${route.url}`);
    }
    for (const method of methods) routes.push(Object.freeze({ method, url: route.url, access }));
  });
  return routes;
}
