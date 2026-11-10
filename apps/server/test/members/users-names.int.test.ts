import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userNamesResponseSchema } from '../../src/shared.js';
import { call, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext, type Session } from '../auth/members-int-harness.js';

/**
 * `GET /api/users/names?ids=`: 비활성 멤버가 남긴 메시지 작성자 이름을 채우는 조회.
 * 같은 워크스페이스 멤버만, 응답 필드는 id·display_name·status·kind뿐, 없는 ID는 빠질 뿐 200.
 */
let ctx: MembersIntContext;
let owner: Session;

const namesUrl = (ids: readonly string[]) => `/api/users/names?ids=${ids.join(',')}`;

beforeEach(async () => {
  ctx = await setupMembersInt();
  owner = await signIn(ctx.app, 'owner@example.test');
});

afterEach(async () => {
  await teardownMembersInt(ctx);
});

describe('GET /api/users/names', () => {
  it('비활성화된 멤버도 이름을 돌려주고 status=disabled, email·role 같은 다른 필드는 없다', async () => {
    const off = await call(ctx.app, 'POST', `/api/admin/members/${ctx.memberId}/deactivate`, owner);
    expect(off.statusCode).toBe(204);
    const res = await call(ctx.app, 'GET', namesUrl([ctx.memberId, ctx.ownerId]), owner);
    expect(res.statusCode).toBe(200);
    const raw = res.json<{ users: Record<string, unknown>[] }>();
    const body = userNamesResponseSchema.parse(raw);
    expect(body.users.find((u) => u.id === ctx.memberId)).toEqual({ id: ctx.memberId, display_name: 'member', status: 'disabled', kind: 'human' });
    expect(body.users.find((u) => u.id === ctx.ownerId)).toEqual({ id: ctx.ownerId, display_name: 'owner', status: 'active', kind: 'human' });
    for (const u of raw.users) expect(Object.keys(u).sort()).toEqual(['display_name', 'id', 'kind', 'status']);
    expect(res.body).not.toMatch(/example\.test|email|role|session/);
  });

  it('없는 ID·워크스페이스 밖 사용자는 응답에서 빠질 뿐 200이고, 중복·대소문자 차이는 한 번만 돌려준다', async () => {
    const outsider = randomUUID();
    await ctx.schema.pool.query(
      "INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, 'outsider@example.test', 'outsider', 'x', 'active')",
      [outsider],
    );
    const otherWs = randomUUID();
    const foreign = randomUUID();
    await ctx.schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'Other', now())", [otherWs]);
    await ctx.schema.pool.query(
      "INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, 'foreign@example.test', 'foreign', 'x', 'active')",
      [foreign],
    );
    await ctx.schema.pool.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [otherWs, foreign]);
    const missing = randomUUID();
    const res = await call(ctx.app, 'GET', namesUrl([ctx.memberId, ctx.memberId.toUpperCase(), missing, outsider, foreign]), owner);
    expect(res.statusCode).toBe(200);
    const body = userNamesResponseSchema.parse(res.json());
    expect(body.users.map((u) => u.id)).toEqual([ctx.memberId]);
  });

  it('ids 100개는 허용, 101개·잘못된 UUID·빈 값은 400', async () => {
    const hundred = Array.from({ length: 100 }, () => randomUUID());
    expect((await call(ctx.app, 'GET', namesUrl(hundred), owner)).statusCode).toBe(200);
    const tooMany = await call(ctx.app, 'GET', namesUrl([...hundred, randomUUID()]), owner);
    expect(tooMany.statusCode).toBe(400);
    expect((await call(ctx.app, 'GET', namesUrl([ctx.memberId, 'not-a-uuid']), owner)).statusCode).toBe(400);
    expect((await call(ctx.app, 'GET', '/api/users/names?ids=', owner)).statusCode).toBe(400);
    expect((await call(ctx.app, 'GET', '/api/users/names', owner)).statusCode).toBe(400);
  });

  it('세션이 없으면 401', async () => {
    expect((await call(ctx.app, 'GET', namesUrl([ctx.memberId]))).statusCode).toBe(401);
  });
});
