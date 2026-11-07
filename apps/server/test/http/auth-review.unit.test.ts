import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { meResponseSchema } from '../../src/shared.js';
import { authed, createMemoryAuthStore, HOST, login, sessionCookie, testApp, type MemoryAuthStore } from '../support/auth-app.js';

/** W-06a 리뷰(p1-w06a-review) 회귀: 세션 고정·로그인 제한 경쟁·404/Origin 순서. */
const SECRET = randomBytes(18).toString('base64url');
const A_ID = '11111111-1111-4111-8111-111111111111';
const B_ID = '22222222-2222-4222-8222-222222222222';
let hash: string;
let app: FastifyInstance | undefined;
let store: MemoryAuthStore;

beforeAll(async () => {
  hash = await hashPassword(SECRET);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(): FastifyInstance {
  store = createMemoryAuthStore();
  store.users.set(A_ID, { id: A_ID, emailNorm: 'a@ohmy.test', displayName: 'A', passwordHash: hash, status: 'active', role: 'owner' });
  store.users.set(B_ID, { id: B_ID, emailNorm: 'b@ohmy.test', displayName: 'B', passwordHash: hash, status: 'active', role: 'member' });
  const now = Date.UTC(2026, 10, 7);
  app = testApp({ authStore: store, clock: () => now });
  return app;
}

describe('session fixation across accounts (review a)', () => {
  it("logging in as A while carrying B's session cookie revokes B's session and issues a new token for A", async () => {
    const a = setup();
    const bToken = sessionCookie(await login(a, 'b@ohmy.test', SECRET)) ?? '';
    expect((await authed(a, 'GET', '/api/me', bToken)).statusCode).toBe(200);
    const res = await login(a, 'a@ohmy.test', SECRET, bToken);
    expect(res.statusCode).toBe(200);
    const aToken = sessionCookie(res) ?? '';
    expect(aToken).not.toBe(bToken);
    expect((await authed(a, 'GET', '/api/me', bToken)).statusCode).toBe(401);
    expect(meResponseSchema.parse((await authed(a, 'GET', '/api/me', aToken)).json()).user.email).toBe('a@ohmy.test');
  });

  it('a failed login does not touch the presented session', async () => {
    const a = setup();
    const bToken = sessionCookie(await login(a, 'b@ohmy.test', SECRET)) ?? '';
    expect((await login(a, 'a@ohmy.test', 'wrong-secret-000', bToken)).statusCode).toBe(401);
    expect((await authed(a, 'GET', '/api/me', bToken)).statusCode).toBe(200);
  });
});

describe('login limiter under concurrency (review c)', () => {
  it('ten concurrent wrong-password attempts for one account verify at most five (the rest are 429)', async () => {
    const a = setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(a, 'a@ohmy.test', 'wrong-secret-000')));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect((await login(a, 'a@ohmy.test', SECRET)).statusCode).toBe(429);
  });

  it('a correct password queued behind the fifth concurrent failure is 429 and gets no session', async () => {
    const a = setup();
    const wrong = Array.from({ length: 5 }, () => login(a, 'a@ohmy.test', 'wrong-secret-000'));
    const right = login(a, 'a@ohmy.test', SECRET);
    const results = await Promise.all([...wrong, right]);
    expect(results.slice(0, 5).map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    const last = results[5];
    expect(last?.statusCode).toBe(429);
    expect(last?.cookies).toHaveLength(0);
    expect(store.sessions.size).toBe(0);
  });

  it('thirty concurrent failures across unknown accounts verify at most twenty before the global block', async () => {
    const a = setup();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => login(a, `nobody${i}@ohmy.test`, 'wrong-secret-000')));
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(20);
    expect((await login(a, 'b@ohmy.test', SECRET)).statusCode).toBe(429);
  });

  it('unknown and existing accounts get the same status sequence when hammered', async () => {
    const seq = async (email: string): Promise<number[]> => {
      const a = setup();
      const out: number[] = [];
      for (let i = 0; i < 7; i += 1) out.push((await login(a, email, 'wrong-secret-000')).statusCode);
      await a.close();
      app = undefined;
      return out;
    };
    const existing = await seq('a@ohmy.test');
    expect(await seq('nobody@ohmy.test')).toEqual(existing);
    expect(existing).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });
});

describe('404 before Origin does not bypass Origin/CSRF on registered routes (review d)', () => {
  it('no path or method variant reaches a state-changing handler with a foreign Origin', async () => {
    const a = setup();
    const token = sessionCookie(await login(a, 'a@ohmy.test', SECRET)) ?? '';
    const urls = [
      '/api/auth/logout',
      '/api/auth/logout/',
      '/API/auth/logout',
      '/api/auth/LOGOUT',
      '/api/auth/%6Cogout',
      '/api/auth/logout?x=1',
      '/api//auth/logout',
      '/api/auth/./logout',
      '/api/auth/login',
      '/api/auth/login/',
      '/api/auth/%6Cogin',
    ];
    for (const url of urls) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
        const res = await a.inject({
          method,
          url,
          headers: { host: HOST, origin: 'https://evil.test', cookie: `${SESSION_COOKIE}=${token}` },
          payload: { email: 'a@ohmy.test', password: SECRET },
        });
        expect([403, 404], `${method} ${url}`).toContain(res.statusCode);
        expect(res.cookies, `${method} ${url}`).toHaveLength(0);
      }
    }
    expect((await authed(a, 'GET', '/api/me', token)).statusCode).toBe(200);
  });

  it('HEAD and OPTIONS cannot change state and set no cookie', async () => {
    const a = setup();
    const token = sessionCookie(await login(a, 'a@ohmy.test', SECRET)) ?? '';
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      for (const url of ['/api/auth/logout', '/api/auth/login', '/api/me']) {
        const res = await a.inject({ method, url, headers: { host: HOST, origin: 'https://evil.test', cookie: `${SESSION_COOKIE}=${token}` } });
        expect(res.statusCode, `${method} ${url}`).not.toBe(204);
        expect(res.cookies, `${method} ${url}`).toHaveLength(0);
      }
    }
    expect((await authed(a, 'GET', '/api/me', token)).statusCode).toBe(200);
  });
});
