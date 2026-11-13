import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { markAccountGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import { loginRequestSchema, type MeResponse, type SessionsResponse } from '../../shared.js';
import { deviceLabelFor } from './device-label.js';
import { accountGuard, requireAuth, SESSION_COOKIE, sessionToken } from './guards.js';
import { csrfTokenFor, SESSION_ABSOLUTE_MS, type Authenticated, type AuthService } from './service.js';

export { SESSION_COOKIE } from './guards.js';

/** Secure는 상수다 — 끄는 설정 경로가 없다(NC-08). */
export const COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_ABSOLUTE_MS / 1000,
});

export function meBody(auth: Pick<Authenticated, 'user' | 'token'>): MeResponse {
  const { user } = auth;
  return {
    user: { id: user.id, email: user.emailNorm, display_name: user.displayName, role: user.role },
    csrf_token: csrfTokenFor(auth.token),
  };
}

async function login(service: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<MeResponse> {
  const parsed = loginRequestSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_request');
  // 원문 User-Agent는 여기서 거친 라벨로만 바뀌고 저장·로그·응답 어디에도 가지 않는다(TRD §5-3 1항, TM-HTTP-22).
  const label = deviceLabelFor(request.headers['user-agent']);
  const result = await service.login(parsed.data.email, parsed.data.password, sessionToken(request), label);
  if (!result.ok) {
    throw result.reason === 'rate_limited' ? new HttpError(429, 'rate_limited') : new HttpError(401, 'invalid_credentials');
  }
  reply.setCookie(SESSION_COOKIE, result.token, COOKIE_OPTIONS);
  return meBody(result);
}

const sessionIdParams = z.object({ id: z.uuid() });

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
        device_label: s.deviceLabel ?? null,
        created_at: s.createdAt.toISOString(),
        last_seen_at: s.lastSeenAt.toISOString(),
        current: s.id === auth.session.id,
      })),
    };
  });

  // 원격 로그아웃(FR-AUTH-04, TRD §5-3 4항). 판정 순서: 가드(인증·CSRF·Origin) → UUID 400 → 현재 세션 400 → 본인 행 404 → 204.
  // 새 account 라우트는 예외 목록이 아니라 표식 가드로 등록한다(B2 레지스트리).
  app.delete('/api/sessions/:id', { config: { access: 'account' }, preHandler: markAccountGuard(accountGuard(service)) }, async (request, reply) => {
    const auth = requireAuth(request);
    const params = sessionIdParams.safeParse(request.params);
    if (!params.success) throw new HttpError(400, 'invalid_request');
    const result = await service.revokeOwnSession(auth, params.data.id);
    if (result === 'current') throw new HttpError(400, 'invalid_request');
    if (result === 'not_found') throw new HttpError(404, 'not_found');
    return reply.code(204).send();
  });
}
