import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { assertLoopbackBind, BindGuardError, parsePort } from '../../src/bind.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_ABSOLUTE_MS, SESSION_SLIDING_MS } from '../../src/modules/auth/service.js';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import { errorResponseSchema, meResponseSchema } from '../../src/shared.js';
import { authed, createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp, type MemoryAuthStore } from '../support/auth-app.js';

const SECRET = randomBytes(18).toString('base64url');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DAY = 24 * 60 * 60 * 1000;
let hash: string;
let app: FastifyInstance | undefined;
let store: MemoryAuthStore;
let now: number;

beforeAll(async () => {
  hash = await hashPassword(SECRET);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(status: 'active' | 'disabled' = 'active'): FastifyInstance {
  store = createMemoryAuthStore();
  store.users.set(USER_ID, { id: USER_ID, emailNorm: 'a@ohmy.test', displayName: 'A', passwordHash: hash, status, role: 'owner' });
  now = Date.UTC(2026, 10, 7);
  app = testApp({ authStore: store, clock: () => now });
  return app;
}

async function loggedIn(): Promise<{ token: string; csrf: string }> {
  const res = await login(setup(), ' A@ohmy.test ', SECRET);
  expect(res.statusCode).toBe(200);
  const token = sessionCookie(res) ?? '';
  return { token, csrf: meResponseSchema.parse(res.json()).csrf_token };
}

describe('access registry (B2)', () => {
  it('collects every route with access meta and refuses a route without it', async () => {
    const a = setup();
    await a.ready();
    const list = a.accessRoutes.map((r) => `${r.method} ${r.url} ${r.access}`);
    expect(list).toEqual(
      expect.arrayContaining([
        'GET /api/healthz public',
        'POST /api/auth/login public',
        'POST /api/auth/logout account',
        'GET /api/me account',
        'GET /api/sessions account',
      ]),
    );
    const bare = buildApp();
    expect(() => bare.get('/api/x', async () => 'x')).toThrow(/access 메타 누락/);
    await bare.close().catch(() => undefined);
  });

  it('rejects unknown app options such as a cookie Secure toggle', () => {
    expect(() => buildApp({ cookieSecure: false } as never)).toThrow(/알 수 없는 앱 옵션/);
    expect(() => buildApp({ allowedOrigin: 'https://ohmy.test/' })).toThrow(/allowedOrigin/);
  });
});

describe('headers, host and origin guards', () => {
  it('sets S6 security headers and no-store on /api', async () => {
    const res = await setup().inject({ method: 'GET', url: '/api/healthz', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('rejects hosts outside the allowlist and malformed hosts', async () => {
    const a = setup();
    for (const host of ['evil.test', 'ohmy.test:8443', 'a@ohmy.test', '']) {
      const res = await a.inject({ method: 'GET', url: '/api/healthz', headers: { host } });
      expect(res.statusCode).toBe(400);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('host_not_allowed');
    }
  });

  it('rejects state changes without the exact origin before touching credentials', async () => {
    const a = setup();
    for (const origin of [undefined, 'null', 'https://ohmy.test:444', 'http://ohmy.test', 'https://evil.test']) {
      const res = await a.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: HOST, ...(origin === undefined ? {} : { origin }) },
        payload: { email: 'a@ohmy.test', password: SECRET },
      });
      expect(res.statusCode).toBe(403);
      expect(res.cookies).toHaveLength(0);
    }
  });

  it('returns the error shape for unknown routes and bad bodies', async () => {
    const a = setup();
    const missing = await a.inject({ method: 'GET', url: '/api/none', headers: { host: HOST } });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe('not_found');
    const bad = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: ORIGIN }, payload: { email: 1 } });
    expect(bad.statusCode).toBe(400);
    const junk = await a.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{',
    });
    expect(errorResponseSchema.parse(junk.json()).error.code).toBe('invalid_request');
  });
});

describe('login, session, logout', () => {
  it('logs in, survives reload via /api/me, lists sessions and logs out to 401', async () => {
    const { token, csrf } = await loggedIn();
    const a = app as FastifyInstance;
    const me = await authed(a, 'GET', '/api/me', token);
    expect(meResponseSchema.parse(me.json()).user.email).toBe('a@ohmy.test');
    const list = await authed(a, 'GET', '/api/sessions', token);
    expect(list.json().sessions).toHaveLength(1);
    expect(list.json().sessions[0].current).toBe(true);
    const noCsrf = await authed(a, 'POST', '/api/auth/logout', token);
    expect(noCsrf.statusCode).toBe(403);
    const out = await authed(a, 'POST', '/api/auth/logout', token, { 'x-csrf-token': csrf });
    expect(out.statusCode).toBe(204);
    expect((await authed(a, 'GET', '/api/me', token)).statusCode).toBe(401);
  });

  it('rejects wrong, unknown and disabled credentials with the same body', async () => {
    const a = setup();
    const wrong = await login(a, 'a@ohmy.test', `${SECRET}x`);
    const unknown = await login(a, 'nobody@ohmy.test', SECRET);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
    const disabled = await login(setup('disabled'), 'a@ohmy.test', SECRET);
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json().error.code).toBe('invalid_credentials');
  });

  it('slides expiry on each authenticated request and stops at the 90-day absolute cap', async () => {
    const { token } = await loggedIn();
    const a = app as FastifyInstance;
    const start = now;
    for (let day = 25; day < 90; day += 25) {
      now = start + day * DAY;
      expect((await authed(a, 'GET', '/api/me', token)).statusCode).toBe(200);
    }
    const session = [...store.sessions.values()][0];
    expect(session?.expiresAt.getTime()).toBe(start + SESSION_ABSOLUTE_MS);
    now = start + SESSION_ABSOLUTE_MS;
    expect((await authed(a, 'GET', '/api/me', token)).statusCode).toBe(401);
  });

  it('expires after 30 idle days', async () => {
    const { token } = await loggedIn();
    now += SESSION_SLIDING_MS;
    expect((await authed(app as FastifyInstance, 'GET', '/api/me', token)).statusCode).toBe(401);
  });

  it('issues a fresh token on every login and revokes the presented session (fixation)', async () => {
    const { token } = await loggedIn();
    const a = app as FastifyInstance;
    const revoked: string[] = [];
    a.authEvents.onSessionRevoked((ids) => revoked.push(...ids));
    const second = await login(a, 'a@ohmy.test', SECRET, token);
    const next = sessionCookie(second) ?? '';
    expect(next).not.toBe(token);
    expect((await authed(a, 'GET', '/api/me', token)).statusCode).toBe(401);
    expect((await authed(a, 'GET', '/api/me', next)).statusCode).toBe(200);
    expect(revoked).toHaveLength(1);
    const planted = await login(a, 'a@ohmy.test', SECRET, 'planted-value');
    expect(sessionCookie(planted)).not.toBe('planted-value');
    expect((await authed(a, 'GET', '/api/me', 'planted-value')).statusCode).toBe(401);
  });

  it('ignores proxy identity headers for authentication', async () => {
    const res = await authed(setup(), 'GET', '/api/me', 'x', {
      'x-forwarded-for': '100.64.0.1',
      'tailscale-user-login': 'a@ohmy.test',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 429 after five failures for one account and recovers after 15 minutes', async () => {
    const a = setup();
    for (let i = 0; i < 5; i += 1) expect((await login(a, 'a@ohmy.test', 'wrong-secret-000')).statusCode).toBe(401);
    expect((await login(a, 'a@ohmy.test', SECRET)).statusCode).toBe(429);
    now += 15 * 60 * 1000;
    expect((await login(a, 'a@ohmy.test', SECRET)).statusCode).toBe(200);
  });
});

describe('bind guard and ops logger', () => {
  it('allows only 127.0.0.1 and validates the port', () => {
    expect(assertLoopbackBind(undefined)).toBe('127.0.0.1');
    for (const host of ['0.0.0.0', '::', '192.168.0.2', 'localhost']) expect(() => assertLoopbackBind(host)).toThrow(BindGuardError);
    expect(parsePort('8080')).toBe(8080);
    expect(() => parsePort('0')).toThrow();
  });

  it('drops fields outside the allowlist', () => {
    const lines: string[] = [];
    createOpsLogger((line) => lines.push(line)).log({ event: 'x', cookie: 'c', email: 'e', status_code: 200, route: { a: 1 } });
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ event: 'x', status_code: 200 });
  });
});
