import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser, call, dbState, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext, type Session } from './members-int-harness.js';
import { login } from '../support/auth-app.js';
import { createPgMembersStore } from '../../src/modules/members/index.js';
import { WS_CLOSE_POLICY } from '../../src/shared.js';
import { as, createChannel, req as convReq } from '../conversations/conv-int-harness.js';
import { closeLatency, connect, setupWsInt, subscribe } from '../realtime/ws-int-harness.js';

/**
 * 비활성화·owner 보호(TRD §3, §5-1 S10, NC-19, TR-SEC-04 HTTP 부분). FR-AUTH-03 지정 `it`은 WS 5초 close(W-09)가
 * 필요해 이 레인에서 만들지 않는다.
 */
let ctx: MembersIntContext;
let owner: Session;

beforeEach(async () => {
  ctx = await setupMembersInt();
  owner = await signIn(ctx.app, 'owner@example.test');
});

afterEach(async () => {
  await teardownMembersInt(ctx);
});

const deactivateUrl = (id: string): string => `/api/admin/members/${id}/deactivate`;

describe('비활성화', () => {
  it('비활성화하면 status=disabled, 그 계정 세션 전부 revoke, sessionRevoked 발행, 이후 HTTP 401·로그인 동일 오류다', async () => {
    const m1 = await signIn(ctx.app, 'member@example.test');
    const m2 = await signIn(ctx.app, 'member@example.test');
    ctx.revokedEvents.length = 0;
    expect((await call(ctx.app, 'POST', deactivateUrl(ctx.memberId), owner)).statusCode).toBe(204);
    const user = await ctx.schema.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [ctx.memberId]);
    expect(user.rows[0]?.status).toBe('disabled');
    const live = await ctx.schema.pool.query('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [ctx.memberId]);
    expect(live.rowCount).toBe(0);
    expect(ctx.revokedEvents.flat()).toHaveLength(2);
    for (const s of [m1, m2]) expect((await call(ctx.app, 'GET', '/api/me', s)).statusCode).toBe(401);
    const relogin = await login(ctx.app, 'member@example.test', 'correct horse battery staple');
    const unknown = await login(ctx.app, 'nobody@example.test', 'correct horse battery staple');
    expect(relogin.statusCode).toBe(401);
    expect(relogin.json().error.code).toBe(unknown.json().error.code);
    expect((await call(ctx.app, 'GET', '/api/members', owner)).json().members).toHaveLength(1);
  });

  it('owner 자기 자신 비활성화는 409이고 DB가 바뀌지 않는다', async () => {
    const before = await dbState(ctx.schema);
    const res = await call(ctx.app, 'POST', deactivateUrl(ctx.ownerId), owner);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('owner_protected');
    expect(await dbState(ctx.schema)).toEqual(before);
  });

  it('두 owner가 서로를 동시에 비활성화하면 HTTP에서는 하나만 성공하고 활성 owner 1명이 남는다', async () => {
    const secondId = await addUser(ctx.schema, 'second@example.test', 'owner');
    const second = await signIn(ctx.app, 'second@example.test');
    const [a, b] = await Promise.all([
      call(ctx.app, 'POST', deactivateUrl(secondId), owner),
      call(ctx.app, 'POST', deactivateUrl(ctx.ownerId), second),
    ]);
    // 진 쪽은 가드 단계(세션이 이미 revoke돼 401) 또는 저장소 트랜잭션(S10 409)에서 거부된다 — 경쟁 순서에 달렸다.
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(204);
    expect([401, 409]).toContain(codes[1]);
    const active = await ctx.schema.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users u JOIN workspace_members m ON m.user_id = u.id WHERE m.role = 'owner' AND u.status = 'active'",
    );
    expect(active.rows[0]?.n).toBe(1);
  });

  it('저장소 트랜잭션: 두 owner 상호 동시 비활성화는 정확히 하나만 커밋되고 나머지는 last_owner(S10)다', async () => {
    const secondId = await addUser(ctx.schema, 'second@example.test', 'owner');
    const store = createPgMembersStore(ctx.schema.pool);
    const at = new Date(ctx.now);
    const results = await Promise.all([store.deactivate(ctx.ownerId, secondId, at), store.deactivate(secondId, ctx.ownerId, at)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'last_owner' }]);
  });

  it('없는 사용자는 404, 잘못된 id는 400이다', async () => {
    expect((await call(ctx.app, 'POST', deactivateUrl('00000000-0000-4000-8000-000000000000'), owner)).statusCode).toBe(404);
    expect((await call(ctx.app, 'POST', deactivateUrl('nope'), owner)).statusCode).toBe(400);
  });
});

describe('비활성화 WS 전파', () => {
  it('FR-AUTH-03 비활성화 후 5초 안에 열린 WS가 닫히고 이후 HTTP·재구독은 401이다', async () => {
    const ws = await setupWsInt();
    try {
      const { app, ids } = ws.conv;
      const owner = await as(app, 'a');
      const b = await as(app, 'b');
      const cid = await createChannel(app, owner, 'general');
      expect((await convReq(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
      const wsB = await ws.open(b.token);
      expect(await subscribe(wsB, cid)).toMatchObject({ type: 'conversation.subscribed' });
      const startedAt = performance.now();
      expect((await convReq(app, 'POST', `/api/admin/members/${ids.b}/deactivate`, owner)).statusCode).toBe(204);
      const { code, ms } = await closeLatency(wsB, startedAt);
      expect(code).toBe(WS_CLOSE_POLICY);
      expect(ms).toBeLessThanOrEqual(5000);
      expect((await convReq(app, 'GET', '/api/me', b)).statusCode).toBe(401);
      expect((await convReq(app, 'GET', `/api/conversations/${cid}/messages`, b)).statusCode).toBe(401);
      // 재구독: 새 WS handshake 자체가 401로 거부된다.
      expect(await connect(ws.base, { token: b.token })).toBe('rejected');
    } finally {
      await ws.teardown();
    }
  });
});
