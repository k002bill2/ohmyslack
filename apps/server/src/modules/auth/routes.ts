import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../http/errors.js';
import { isStateChanging } from '../../http/security.js';
import { loginRequestSchema, type MeResponse, type SessionsResponse } from '../../shared.js';
import { csrfMatches, csrfTokenFor, SESSION_ABSOLUTE_MS, type Authenticated, type AuthService } from './service.js';

/**
 * 세션 쿠키(TRD §5, TR-SEC-11). `__Host-` 접두는 브라우저가 Secure·Path=/·Domain 없음을 강제한다.
 * Secure는 상수다 — 끄는 설정 경로가 없다(NC-08).
 */
export const SESSION_COOKIE = '__Host-oms_session';
const COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_ABSOLUTE_MS / 1000,
});

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Authenticated;
  }
}

function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

function requireAuth(request: FastifyRequest): Authenticated {
  if (request.auth === undefined) throw new HttpError(401, 'unauthenticated');
  return request.auth;
}

/** `account` 메타 라우트의 preHandler: 세션 확인(+sliding) → 상태 변경이면 CSRF 헤더 확인. */
function accountGuard(service: AuthService) {
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

function meBody(auth: Pick<Authenticated, 'user' | 'token'>): MeResponse {
  const { user } = auth;
  return {
    user: { id: user.id, email: user.emailNorm, display_name: user.displayName, role: user.role },
    csrf_token: csrfTokenFor(auth.token),
  };
}

async function login(service: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<MeResponse> {
  const parsed = loginRequestSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_request');
  const result = await service.login(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    throw result.reason === 'rate_limited' ? new HttpError(429, 'rate_limited') : new HttpError(401, 'invalid_credentials');
  }
  await service.revokeByToken(sessionToken(request));
  reply.setCookie(SESSION_COOKIE, result.token, COOKIE_OPTIONS);
  return meBody(result);
}

export function registerAuthRoutes(app: FastifyInstance, service: AuthService): void {
  const preHandler = accountGuard(service);

  app.post('/api/auth/login', { config: { access: 'public' }, bodyLimit: 4096 }, (request, reply) =>
    login(service, request, reply),
  );

  app.post('/api/auth/logout', { config: { access: 'account' }, preHandler }, async (request, reply) => {
    await service.logout(requireAuth(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    return reply.code(204).send();
  });

  app.get('/api/me', { config: { access: 'account' }, preHandler }, async (request) => meBody(requireAuth(request)));

  app.get('/api/sessions', { config: { access: 'account' }, preHandler }, async (request): Promise<SessionsResponse> => {
    const auth = requireAuth(request);
    const sessions = await service.listSessions(auth);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        created_at: s.createdAt.toISOString(),
        last_seen_at: s.lastSeenAt.toISOString(),
        expires_at: s.expiresAt.toISOString(),
        current: s.id === auth.session.id,
      })),
    };
  });
}
