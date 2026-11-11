import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_GUARD_EXEMPT, AccessMetaError, markAccountGuard, registerAccessRegistry } from '../../src/http/access.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { MembersStore } from '../../src/modules/members/store.js';
import { meResponseSchema } from '../../src/shared.js';
import { createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp } from '../support/auth-app.js';

/** W-15 P1 보안 리뷰 F-4·F-5·H-1·H-2 회귀(정본: docs/08-security/SECURITY_REVIEW_P1.md §1·§6). */
const SECRET = ['correct', 'horse', 'battery', 'staple'].join(' ');
const OWNER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let hash: string;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  hash = await hashPassword(SECRET);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

interface MembersSpy {
  readonly store: MembersStore;
  readonly deactivated: string[];
}

/** deactivate가 항상 성공하는 저장소 — 라우트의 자기 비활성화 판정만으로 409가 나는지 본다(H-2). */
function membersSpy(): MembersSpy {
  const deactivated: string[] = [];
  return {
    deactivated,
    store: {
      insertInvite: unused,
      revokeInvite: unused,
      isInviteUsable: unused,
      acceptInvite: unused,
      listActiveMembers: async () => [],
      findUserNames: unused,
      async deactivate(_actor, target) {
        deactivated.push(target);
        return { ok: true, revokedSessionIds: [] };
      },
    },
  };
}

function baseApp(): FastifyInstance {
  const auth = createMemoryAuthStore();
  auth.users.set(OWNER_ID, { id: OWNER_ID, emailNorm: 'o@ohmy.test', displayName: 'O', kind: 'human', passwordHash: hash, status: 'active', role: 'owner' });
  app = testApp({ authStore: auth });
  return app;
}

describe('F-4 · /api 판정은 정규화된 경로 기준(S5 no-store)', () => {
  it.each(['/api/healthz', '/%61pi/healthz', '/%61%70%69/healthz'])('%s → 200 no-store', async (url) => {
    const res = await baseApp().inject({ method: 'GET', url, headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(['/API/healthz', '//api/healthz', '/Api/nope', '/%2Fapi/x', '/./api/healthz'])('%s (변형) → no-store', async (url) => {
    const res = await baseApp().inject({ method: 'GET', url, headers: { host: HOST } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('API가 아닌 경로에는 no-store를 붙이지 않는다', async () => {
    const res = await baseApp().inject({ method: 'GET', url: '/apix', headers: { host: HOST } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});

describe('F-5 · 잘못된 URL 인코딩도 S6 헤더·Host 가드·오류 형식을 지킨다', () => {
  it('GET /%zz → 400 invalid_request, S6 헤더, 원문 경로 미반사', async () => {
    const res = await baseApp().inject({ method: 'GET', url: '/%zz', headers: { host: HOST } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; request_id: string } };
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.request_id).toMatch(UUID_RE);
    expect(res.body).not.toContain('%zz');
    expect(res.body).not.toContain('FST_');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('/api 아래의 잘못된 인코딩도 같은 형식이다', async () => {
    const res = await baseApp().inject({ method: 'GET', url: '/api/%zz', headers: { host: HOST } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_request');
    expect(res.body).not.toContain('%zz');
  });

  it('허용되지 않은 Host + /%zz → host_not_allowed (Host 가드 우회 없음)', async () => {
    const res = await baseApp().inject({ method: 'GET', url: '/%zz', headers: { host: 'evil.test' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('host_not_allowed');
    expect(res.body).not.toContain('%zz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('H-1 · account 라우트도 레지스트리가 가드 표식을 강제한다', () => {
  it('표식 없는(또는 가드 없는) 새 account 라우트는 기동 실패', () => {
    const bare = Fastify();
    registerAccessRegistry(bare);
    const plain = async (): Promise<void> => undefined;
    expect(() => bare.get('/api/x', { config: { access: 'account' }, preHandler: plain }, async () => 'x')).toThrow(AccessMetaError);
    expect(() => bare.get('/api/y', { config: { access: 'account' } }, async () => 'y')).toThrow(/account 가드 누락/);
    // 면제 집합의 URL이어도 다른 메서드면 통과하지 않는다.
    expect(() => bare.delete('/api/me', { config: { access: 'account' }, preHandler: plain }, async () => 'z')).toThrow(AccessMetaError);
    expect(() => bare.get('/api/ok', { config: { access: 'account' }, preHandler: [markAccountGuard(async () => undefined)] }, async () => 'ok')).not.toThrow();
  });

  it('면제 집합 = 실제로 표식 없이 등록된 account 라우트(집합이 몰래 늘지 않음)', async () => {
    const auth = createMemoryAuthStore();
    const stub = new Proxy({}, { get: () => unused });
    const full = testApp({
      authStore: auth,
      membersStore: membersSpy().store,
      conversationsStore: stub as never,
      messagesStore: stub as never,
      syncStore: stub as never,
    });
    app = full;
    await full.ready();
    const exempt = full.accessRoutes.filter((r) => r.guardExempt === true).map((r) => `${r.method} ${r.url}`);
    expect([...exempt].sort()).toEqual([...ACCOUNT_GUARD_EXEMPT].sort());
    const marked = full.accessRoutes.filter((r) => r.access === 'account' && r.guardExempt !== true).map((r) => `${r.method} ${r.url}`);
    expect(marked).toEqual(expect.arrayContaining(['GET /api/sync', 'GET /api/sync/snapshot', 'PUT /api/read-state', 'GET /api/members']));
  });
});

describe('H-2 · owner 자기 비활성화 판정은 UUID 대소문자를 무시한다', () => {
  async function ownerSession(): Promise<{ readonly a: FastifyInstance; readonly spy: MembersSpy; readonly cookie: string; readonly csrf: string }> {
    const auth = createMemoryAuthStore();
    auth.users.set(OWNER_ID, { id: OWNER_ID, emailNorm: 'o@ohmy.test', displayName: 'O', kind: 'human', passwordHash: hash, status: 'active', role: 'owner' });
    const spy = membersSpy();
    const a = testApp({ authStore: auth, membersStore: spy.store });
    app = a;
    const res = await login(a, 'o@ohmy.test', SECRET);
    return { a, spy, cookie: sessionCookie(res) ?? '', csrf: meResponseSchema.parse(res.json()).csrf_token };
  }

  it.each([OWNER_ID, OWNER_ID.toUpperCase()])('self id %s → 409 owner_protected, 저장소 미호출', async (target) => {
    const { a, spy, cookie, csrf } = await ownerSession();
    const res = await a.inject({
      method: 'POST',
      url: `/api/admin/members/${target}/deactivate`,
      headers: { host: HOST, origin: ORIGIN, 'x-csrf-token': csrf, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('owner_protected');
    expect(spy.deactivated).toEqual([]);
  });

  it('다른 사용자는 그대로 비활성화된다', async () => {
    const { a, spy, cookie, csrf } = await ownerSession();
    const other = randomUUID();
    const res = await a.inject({
      method: 'POST',
      url: `/api/admin/members/${other}/deactivate`,
      headers: { host: HOST, origin: ORIGIN, 'x-csrf-token': csrf, cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.statusCode).toBe(204);
    expect(spy.deactivated).toEqual([other]);
  });
});
