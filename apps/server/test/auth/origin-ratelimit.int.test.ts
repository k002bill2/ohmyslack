import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meResponseSchema } from '../../src/shared.js';
import { authed, HOST, login, sessionCookie } from '../support/auth-app.js';
import { setupAuthInt, teardownAuthInt, type AuthIntContext } from './auth-int-harness.js';

/**
 * FR-AUTH-06·FR-AUTH-02의 HTTP 부분(정본 TRD §5·§5-1 S1). 지정 이름 `it`은 WS 단언이 필요해 W-09에서 완성한다.
 */
const SECRET = 'origin-ratelimit-secret-01';
const EMAIL = 'rl@example.test';
const MIN = 60 * 1000;
let ctx: AuthIntContext | undefined;

beforeEach(async () => {
  ctx = await setupAuthInt(EMAIL, SECRET);
});

afterEach(async () => {
  await teardownAuthInt(ctx);
  ctx = undefined;
});

async function sessionCount(c: AuthIntContext): Promise<number> {
  const res = await c.schema.pool.query<{ n: string }>('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL');
  return Number(res.rows[0]?.n);
}

describe('auth HTTP over a real DB', () => {
  it('account limit: 4 failures allowed, 5th blocks, 6th is 429, recovers after 15 minutes', async () => {
    const c = ctx as AuthIntContext;
    for (let i = 1; i <= 4; i += 1) expect((await login(c.app, EMAIL, 'wrong-secret-xx')).statusCode).toBe(401);
    expect((await login(c.app, EMAIL, 'wrong-secret-xx')).statusCode).toBe(401);
    expect((await login(c.app, EMAIL, SECRET)).statusCode).toBe(429);
    c.now += 15 * MIN;
    expect((await login(c.app, EMAIL, SECRET)).statusCode).toBe(200);
  });

  it('a successful login resets the account counter (4 failures, success, 4 more failures stay allowed)', async () => {
    const c = ctx as AuthIntContext;
    for (let i = 1; i <= 4; i += 1) expect((await login(c.app, EMAIL, 'wrong-secret-xx')).statusCode).toBe(401);
    expect((await login(c.app, EMAIL, SECRET)).statusCode).toBe(200);
    for (let i = 1; i <= 4; i += 1) expect((await login(c.app, EMAIL, 'wrong-secret-xx')).statusCode).toBe(401);
    expect((await login(c.app, EMAIL, SECRET)).statusCode).toBe(200);
  });

  it('global limit: 20 failures across accounts block every login for 15 minutes', async () => {
    const c = ctx as AuthIntContext;
    for (let i = 0; i < 20; i += 1) expect((await login(c.app, `nobody${i}@example.test`, 'x')).statusCode).toBe(401);
    expect((await login(c.app, EMAIL, SECRET)).statusCode).toBe(429);
    c.now += 15 * MIN;
    expect((await login(c.app, EMAIL, SECRET)).statusCode).toBe(200);
  });

  it('unauthenticated, wrong-origin and wrong-CSRF requests change nothing', async () => {
    const c = ctx as AuthIntContext;
    expect((await c.app.inject({ method: 'GET', url: '/api/me', headers: { host: HOST } })).statusCode).toBe(401);
    const res = await login(c.app, EMAIL, SECRET);
    const token = sessionCookie(res) ?? '';
    const csrf = meResponseSchema.parse(res.json()).csrf_token;
    const before = await sessionCount(c);
    for (const origin of ['https://evil.test', 'null', 'https://ohmy.test:8443']) {
      expect((await authed(c.app, 'POST', '/api/auth/logout', token, { origin, 'x-csrf-token': csrf })).statusCode).toBe(403);
    }
    expect((await authed(c.app, 'POST', '/api/auth/logout', token, { 'x-csrf-token': `${csrf}x` })).statusCode).toBe(403);
    expect(await sessionCount(c)).toBe(before);
  });

  it('logout revokes in DB, keeps other device sessions, and a session reused after 5 minutes stays valid', async () => {
    const c = ctx as AuthIntContext;
    const revoked: string[] = [];
    c.app.authEvents.onSessionRevoked((ids) => revoked.push(...ids));
    const a = await login(c.app, EMAIL, SECRET);
    const b = await login(c.app, EMAIL, SECRET);
    const tokenA = sessionCookie(a) ?? '';
    const tokenB = sessionCookie(b) ?? '';
    c.now += 5 * MIN;
    expect((await authed(c.app, 'GET', '/api/me', tokenA)).statusCode).toBe(200);
    const csrf = meResponseSchema.parse(a.json()).csrf_token;
    expect((await authed(c.app, 'POST', '/api/auth/logout', tokenA, { 'x-csrf-token': csrf })).statusCode).toBe(204);
    expect((await authed(c.app, 'GET', '/api/me', tokenA)).statusCode).toBe(401);
    expect((await authed(c.app, 'GET', '/api/me', tokenB)).statusCode).toBe(200);
    expect(revoked).toHaveLength(1);
    const listed = await authed(c.app, 'GET', '/api/sessions', tokenB);
    expect(listed.json().sessions).toHaveLength(1);
  });
});
