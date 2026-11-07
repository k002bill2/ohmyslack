import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type AppOptions } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { AuthStore, SessionRecord, UserRecord } from '../../src/modules/auth/store.js';

/** 인증 테스트 공통: 허용 출처·Host, 쿠키 추출, 메모리 저장소. */
export const ORIGIN = 'https://ohmy.test';
export const HOST = 'ohmy.test';

export interface MemoryAuthStore extends AuthStore {
  readonly users: Map<string, UserRecord>;
  readonly sessions: Map<string, SessionRecord>;
}

export function createMemoryAuthStore(): MemoryAuthStore {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const update = (id: string, patch: Partial<SessionRecord>): void => {
    const current = sessions.get(id);
    if (current !== undefined) sessions.set(id, { ...current, ...patch });
  };
  return {
    users,
    sessions,
    async findUserByEmail(emailNorm) {
      return [...users.values()].find((u) => u.emailNorm === emailNorm);
    },
    async findUserById(id) {
      return users.get(id);
    },
    async insertSession(session) {
      sessions.set(session.id, session);
    },
    async findSessionByTokenHash(tokenHash) {
      return [...sessions.values()].find((s) => s.tokenHash === tokenHash);
    },
    async touchSession(id, lastSeenAt, expiresAt) {
      if (sessions.get(id)?.revokedAt === null) update(id, { lastSeenAt, expiresAt });
    },
    async revokeSession(id, revokedAt) {
      if (sessions.get(id)?.revokedAt === null) update(id, { revokedAt });
    },
    async listLiveSessions(userId, now) {
      return [...sessions.values()].filter((s) => s.userId === userId && s.revokedAt === null && s.expiresAt > now);
    },
  };
}

export function testApp(options: AppOptions): FastifyInstance {
  return buildApp({ allowedOrigin: ORIGIN, logger: { log: () => undefined }, ...options });
}

export function sessionCookie(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
}

export function login(app: FastifyInstance, email: string, secret: string, cookie?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: HOST, origin: ORIGIN, ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` }) },
    payload: { email, password: secret },
  });
}

export function authed(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  token: string,
  extra: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${token}`, ...extra } });
}
