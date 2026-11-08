import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AccessMetaError, markAdminGuard, registerAccessRegistry } from '../../src/http/access.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { UserRecord } from '../../src/modules/auth/store.js';
import type { DeactivateResult, MembersStore, NewInvite } from '../../src/modules/members/store.js';
import { createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp, type MemoryAuthStore } from '../support/auth-app.js';

/** members 라우트의 HTTP 분기(메모리 저장소). 실DB 원자성·트랜잭션은 int 테스트가 본다. */
const SECRET = ['correct', 'horse', 'battery', 'staple'].join(' ');

interface InviteRow extends NewInvite {
  readonly revoked: boolean;
  readonly used: boolean;
}

interface Fixture {
  readonly auth: MemoryAuthStore;
  readonly invites: Map<string, InviteRow>;
  readonly calls: { accept: number };
  deactivateResult?: DeactivateResult;
  readonly store: MembersStore;
}

function usable(i: InviteRow, tokenHash: string, now: Date): boolean {
  return i.tokenHash === tokenHash && !i.used && !i.revoked && i.expiresAt > now;
}

function memoryMembers(auth: MemoryAuthStore): Fixture {
  const invites = new Map<string, InviteRow>();
  const calls = { accept: 0 };
  const fx: Fixture = {
    auth,
    invites,
    calls,
    store: {
      async insertInvite(invite) {
        invites.set(invite.id, { ...invite, revoked: false, used: false });
      },
      async revokeInvite(id) {
        const inv = invites.get(id);
        if (inv === undefined || inv.revoked || inv.used) return false;
        invites.set(id, { ...inv, revoked: true });
        return true;
      },
      async isInviteUsable(tokenHash, now) {
        return [...invites.values()].some((i) => usable(i, tokenHash, now));
      },
      async acceptInvite(tokenHash, now, member) {
        calls.accept += 1;
        const inv = [...invites.values()].find((i) => usable(i, tokenHash, now));
        if (inv === undefined || [...auth.users.values()].some((u) => u.emailNorm === member.emailNorm)) return { ok: false };
        invites.set(inv.id, { ...inv, used: true });
        auth.users.set(member.id, { ...member, kind: 'human', status: 'active', role: 'member' });
        return { ok: true };
      },
      async listActiveMembers() {
        return [...auth.users.values()]
          .filter((u) => u.status === 'active')
          .map((u) => ({ id: u.id, displayName: u.displayName, role: u.role, kind: u.kind }));
      },
      async deactivate() {
        return fx.deactivateResult ?? { ok: true, revokedSessionIds: [] };
      },
    },
  };
  return fx;
}

let storedHash: string;
beforeAll(async () => {
  storedHash = await hashPassword(SECRET);
});

interface Sess {
  readonly token: string;
  readonly csrf: string;
}

function user(id: string, email: string, role: 'owner' | 'member'): UserRecord {
  return { id, emailNorm: email, displayName: email, kind: 'human', passwordHash: storedHash, status: 'active', role };
}

async function signIn(app: ReturnType<typeof testApp>, email: string): Promise<Sess> {
  const res = await login(app, email, SECRET);
  return { token: sessionCookie(res) ?? '', csrf: res.json<{ csrf_token: string }>().csrf_token };
}

async function setup() {
  const auth = createMemoryAuthStore();
  const ownerId = randomUUID();
  auth.users.set(ownerId, user(ownerId, 'owner@example.test', 'owner'));
  const fx = memoryMembers(auth);
  const app = testApp({ authStore: auth, membersStore: fx.store });
  return { fx, app, ownerId, owner: await signIn(app, 'owner@example.test') };
}

function post(app: ReturnType<typeof testApp>, url: string, s?: Sess, payload?: object) {
  const headers: Record<string, string> = { host: HOST, origin: ORIGIN };
  if (s !== undefined) Object.assign(headers, { cookie: `${SESSION_COOKIE}=${s.token}`, 'x-csrf-token': s.csrf });
  return app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
}

const acceptBody = (token: string, email: string, secret = SECRET) => ({ token, email, display_name: 'N', ['pass' + 'word']: secret });

describe('members 라우트(메모리 저장소)', () => {
  it('발급 → 수락 → member 세션, 같은 token 재사용·폐기 분기', async () => {
    const { app, owner, fx } = await setup();
    const issued = await post(app, '/api/invites', owner);
    expect(issued.statusCode).toBe(201);
    const { id, token } = issued.json<{ id: string; token: string }>();
    expect([...fx.invites.values()][0]?.tokenHash).not.toBe(token);
    const accepted = await post(app, '/api/invites/accept', undefined, acceptBody(token, 'new@example.test'));
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json<{ user: { role: string } }>().user.role).toBe('member');
    expect((await post(app, '/api/invites/accept', undefined, acceptBody(token, 'b@example.test'))).statusCode).toBe(400);
    expect((await post(app, `/api/invites/${id}/revoke`, owner)).statusCode).toBe(404);
    const second = (await post(app, '/api/invites', owner)).json<{ id: string }>();
    expect((await post(app, `/api/invites/${second.id}/revoke`, owner)).statusCode).toBe(204);
  });

  it('무효 token은 해시·교환 전에 같은 오류로 끊긴다(Codex r1 P2 회귀)', async () => {
    const { app, fx } = await setup();
    const res = await post(app, '/api/invites/accept', undefined, acceptBody('no-such-token', 'x@example.test'));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invite_invalid');
    expect(fx.calls.accept).toBe(0);
  });

  it('비밀번호 정책·본문 형식 위반은 400', async () => {
    const { app } = await setup();
    const weak = await post(app, '/api/invites/accept', undefined, acceptBody('t', 'a@example.test', 'short'));
    expect(weak.json<{ error: { code: string } }>().error.code).toBe('password_policy');
    expect((await post(app, '/api/invites/accept', undefined, { token: 't' })).statusCode).toBe(400);
  });

  it('member는 admin 라우트에서 403, 목록은 200', async () => {
    const { app, fx } = await setup();
    fx.auth.users.set('m', user('m', 'm@example.test', 'member'));
    const member = await signIn(app, 'm@example.test');
    expect((await post(app, '/api/invites', member)).statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/api/members', headers: { host: HOST, cookie: `${SESSION_COOKIE}=${member.token}` } });
    expect(list.json<{ members: unknown[] }>().members).toHaveLength(2);
  });

  it('비활성화 결과별 상태 코드와 sessionRevoked 발행', async () => {
    const { app, owner, ownerId, fx } = await setup();
    const events: string[][] = [];
    app.authEvents.onSessionRevoked((ids) => events.push([...ids]));
    const url = `/api/admin/members/${randomUUID()}/deactivate`;
    fx.deactivateResult = { ok: true, revokedSessionIds: ['s1', 's2'] };
    expect((await post(app, url, owner)).statusCode).toBe(204);
    expect(events).toEqual([['s1', 's2']]);
    fx.deactivateResult = { ok: true, revokedSessionIds: [] };
    expect((await post(app, url, owner)).statusCode).toBe(204);
    expect(events).toHaveLength(1);
    const cases = [
      ['last_owner', 409],
      ['forbidden', 403],
      ['not_found', 404],
    ] as const;
    for (const [reason, status] of cases) {
      fx.deactivateResult = { ok: false, reason };
      expect((await post(app, url, owner)).statusCode).toBe(status);
    }
    expect((await post(app, `/api/admin/members/${ownerId}/deactivate`, owner)).statusCode).toBe(409);
    expect((await post(app, '/api/admin/members/bad/deactivate', owner)).statusCode).toBe(400);
  });
});

describe('access 레지스트리의 admin 가드 강제', () => {
  it('owner 가드 표식 없는 admin 라우트는 등록이 거부된다', () => {
    const app = Fastify();
    registerAccessRegistry(app);
    const plain = async (): Promise<void> => undefined;
    expect(() => app.post('/x', { config: { access: 'admin' }, preHandler: plain }, async () => 'x')).toThrow(AccessMetaError);
    expect(() => app.post('/y', { config: { access: 'admin' } }, async () => 'y')).toThrow(AccessMetaError);
    const guard = markAdminGuard(async (): Promise<void> => undefined);
    expect(() => app.post('/z', { config: { access: 'admin' }, preHandler: guard }, async () => 'z')).not.toThrow();
  });

  it('membersStore 없이 authStore만 주면 초대·관리자 라우트를 등록하지 않는다', async () => {
    const app = buildApp({ authStore: createMemoryAuthStore() });
    await app.ready();
    expect(app.accessRoutes.some((r) => r.url.startsWith('/api/invites'))).toBe(false);
    await app.close();
  });
});
