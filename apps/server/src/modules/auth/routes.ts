import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../http/errors.js';
import { loginRequestSchema, type MeResponse, type SessionsResponse } from '../../shared.js';
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
  const result = await service.login(parsed.data.email, parsed.data.password, sessionToken(request));
  if (!result.ok) {
    throw result.reason === 'rate_limited' ? new HttpError(429, 'rate_limited') : new HttpError(401, 'invalid_credentials');
  }
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
