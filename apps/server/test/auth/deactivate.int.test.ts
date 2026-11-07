import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser, call, dbState, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext, type Session } from './members-int-harness.js';
import { login } from '../support/auth-app.js';

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

  it('두 owner가 서로를 동시에 비활성화하면 하나만 성공하고 마지막 owner는 409로 남는다', async () => {
    const secondId = await addUser(ctx.schema, 'second@example.test', 'owner');
    const second = await signIn(ctx.app, 'second@example.test');
    const [a, b] = await Promise.all([
      call(ctx.app, 'POST', deactivateUrl(secondId), owner),
      call(ctx.app, 'POST', deactivateUrl(ctx.ownerId), second),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 409]);
    const active = await ctx.schema.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users u JOIN workspace_members m ON m.user_id = u.id WHERE m.role = 'owner' AND u.status = 'active'",
    );
    expect(active.rows[0]?.n).toBe(1);
  });

  it('없는 사용자는 404, 잘못된 id는 400이다', async () => {
    expect((await call(ctx.app, 'POST', deactivateUrl('00000000-0000-4000-8000-000000000000'), owner)).statusCode).toBe(404);
    expect((await call(ctx.app, 'POST', deactivateUrl('nope'), owner)).statusCode).toBe(400);
  });
});
