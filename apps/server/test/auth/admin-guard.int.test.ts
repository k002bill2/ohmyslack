import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, dbState, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext } from './members-int-harness.js';

/** admin 메타 가드(DEV_DESIGN §2-4). 채널 생성 403은 W-07에서 FR-AUTH-05 지정 `it`으로 완성한다. */
let ctx: MembersIntContext;

beforeEach(async () => {
  ctx = await setupMembersInt();
});

afterEach(async () => {
  await teardownMembersInt(ctx);
});

describe('admin 가드', () => {
  it('일반 멤버의 초대 발급·폐기·비활성화 요청은 403이고 DB 상태가 바뀌지 않는다', async () => {
    const owner = await signIn(ctx.app, 'owner@example.test');
    const invite = (await call(ctx.app, 'POST', '/api/invites', owner)).json<{ id: string }>();
    const member = await signIn(ctx.app, 'member@example.test');
    const before = await dbState(ctx.schema);
    const attempts = [
      call(ctx.app, 'POST', '/api/invites', member),
      call(ctx.app, 'POST', `/api/invites/${invite.id}/revoke`, member),
      call(ctx.app, 'POST', `/api/admin/members/${ctx.ownerId}/deactivate`, member),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    expect(await dbState(ctx.schema)).toEqual(before);
  });

  it('세션 없는 admin 요청은 401, CSRF 헤더 없는 owner 요청은 403이다', async () => {
    expect((await call(ctx.app, 'POST', '/api/invites')).statusCode).toBe(401);
    const owner = await signIn(ctx.app, 'owner@example.test');
    const res = await call(ctx.app, 'POST', '/api/invites', { token: owner.token, csrf: 'wrong' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });

  it('레지스트리: admin 라우트는 모두 admin 메타로 등록돼 있다', () => {
    const admin = ctx.app.accessRoutes.filter((r) => r.access === 'admin').map((r) => `${r.method} ${r.url}`);
    expect(admin.sort()).toEqual(['POST /api/admin/members/:user_id/deactivate', 'POST /api/invites', 'POST /api/invites/:id/revoke']);
    const pub = ctx.app.accessRoutes.filter((r) => r.access === 'public').map((r) => r.url);
    expect(pub).toContain('/api/invites/accept');
  });
});
