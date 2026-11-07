import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { markAdminGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import { isStateChanging } from '../../http/security.js';
import { csrfMatches, type Authenticated, type AuthService } from './service.js';

/** 세션 쿠키 이름(TRD §5, TR-SEC-11). `__Host-` 접두는 브라우저가 Secure·Path=/·Domain 없음을 강제한다. */
export const SESSION_COOKIE = '__Host-oms_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Authenticated;
  }
}

export function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

export function requireAuth(request: FastifyRequest): Authenticated {
  if (request.auth === undefined) throw new HttpError(401, 'unauthenticated');
  return request.auth;
}

/** `account` 메타 라우트의 preHandler: 세션 확인(+sliding) → 상태 변경이면 CSRF 헤더 확인. */
export function accountGuard(service: AuthService): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = await service.authenticate(sessionToken(request));
    if (auth === undefined) throw new HttpError(401, 'unauthenticated');
    if (isStateChanging(request.method)) {
      const header = request.headers['x-csrf-token'];
      if (!csrfMatches(auth.token, Array.isArray(header) ? header[0] : header)) throw new HttpError(403, 'csrf_rejected');
    }
    request.auth = auth;
  };
}

/**
 * `admin` 메타 라우트의 preHandler 묶음(DEV_DESIGN §2-4): account 확인 뒤 workspace owner가 아니면 403.
 * 처리기 전에 거부하므로 DB는 바뀌지 않는다. 레지스트리가 이 표식이 붙은 가드를 강제한다.
 */
export function adminGuards(service: AuthService): readonly preHandlerAsyncHookHandler[] {
  const ownerOnly = markAdminGuard(async (request: FastifyRequest): Promise<void> => {
    if (requireAuth(request).user.role !== 'owner') throw new HttpError(403, 'forbidden');
  });
  return [accountGuard(service), ownerOnly];
}
