import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVITE_TTL_MS } from '../../src/modules/members/routes.js';
import { inviteCreateResponseSchema, meResponseSchema } from '../../src/shared.js';
import { acceptBody, call, dbState, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext, type Session } from './members-int-harness.js';

/**
 * 초대 발급·수락·폐기 HTTP·DB 부분(TRD §3, §5-1 S2·S3, NC-16·NC-20). FR-AUTH-01 지정 `it`은 구독 거부(W-09)가
 * 필요해 이 레인에서 만들지 않는다 — 여기서는 일반 이름으로 HTTP·DB 부분을 검증한다.
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

async function issue(): Promise<{ id: string; token: string; expires_at: string }> {
  const res = await call(ctx.app, 'POST', '/api/invites', owner);
  expect(res.statusCode).toBe(201);
  return inviteCreateResponseSchema.parse(res.json());
}

function accept(token: string, email: string, password?: string) {
  return call(ctx.app, 'POST', '/api/invites/accept', undefined, acceptBody(token, email, password));
}

async function userCount(email: string): Promise<number> {
  const res = await ctx.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE email_norm = $1', [email]);
  return res.rows[0]?.n ?? -1;
}

describe('초대 발급·수락·폐기', () => {
  it('발급은 32바이트 base64url token을 한 번 돌려주고 DB에는 SHA-256만, 만료는 72시간 뒤다', async () => {
    const invite = await issue();
    expect(Buffer.from(invite.token, 'base64url')).toHaveLength(32);
    expect(new Date(invite.expires_at).getTime()).toBe(ctx.now + INVITE_TTL_MS);
    const rows = await ctx.schema.pool.query<{ token_hash: string; created_by: string }>('SELECT token_hash, created_by FROM invites');
    expect(rows.rows).toEqual([{ token_hash: createHash('sha256').update(invite.token).digest('hex'), created_by: ctx.ownerId }]);
    expect(JSON.stringify(await dbState(ctx.schema)).includes(invite.token)).toBe(false);
  });

  it('수락하면 member 계정과 세션이 생기고 같은 token은 다시 쓸 수 없다', async () => {
    const invite = await issue();
    const res = await accept(invite.token, ' New@Example.TEST ');
    expect(res.statusCode).toBe(201);
    const me = meResponseSchema.parse(res.json());
    expect(me.user).toMatchObject({ email: 'new@example.test', role: 'member' });
    const cookie = res.cookies.find((c) => c.name.endsWith('oms_session'));
    expect(cookie?.value).toBeTruthy();
    expect((await call(ctx.app, 'GET', '/api/me', { token: cookie?.value ?? '', csrf: me.csrf_token })).statusCode).toBe(200);
    const again = await accept(invite.token, 'other@example.test');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invite_invalid');
    expect(await userCount('other@example.test')).toBe(0);
  });

  it('동시 수락 10건 중 1건만 성공하고 계정도 1개만 생긴다', async () => {
    const invite = await issue();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => accept(invite.token, `racer${i}@example.test`)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 400 && r.json().error.code === 'invite_invalid')).toHaveLength(9);
    const created = await ctx.schema.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email_norm LIKE 'racer%'");
    expect(created.rows[0]?.n).toBe(1);
    const roles = await ctx.schema.pool.query<{ role: string }>(
      "SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email_norm LIKE 'racer%'",
    );
    expect(roles.rows).toEqual([{ role: 'member' }]);
  });

  it('72시간 경계: 직전까지는 수락되고 정각부터는 거부된다(가짜 시계)', async () => {
    const early = await issue();
    const late = await issue();
    ctx.now += INVITE_TTL_MS - 1;
    expect((await accept(early.token, 'early@example.test')).statusCode).toBe(201);
    ctx.now += 1;
    const res = await accept(late.token, 'late@example.test');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invite_invalid');
    expect(await userCount('late@example.test')).toBe(0);
  });

  it('폐기 후 수락은 실패하고, 만료·사용·폐기·없는 token은 같은 응답이며 DB를 바꾸지 않는다', async () => {
    const revoked = await issue();
    expect((await call(ctx.app, 'POST', `/api/invites/${revoked.id}/revoke`, owner)).statusCode).toBe(204);
    expect((await call(ctx.app, 'POST', `/api/invites/${revoked.id}/revoke`, owner)).statusCode).toBe(404);
    const used = await issue();
    expect((await accept(used.token, 'used@example.test')).statusCode).toBe(201);
    const expired = await issue();
    ctx.now += INVITE_TTL_MS;
    const before = await dbState(ctx.schema);
    const bodies = [];
    for (const token of [revoked.token, used.token, expired.token, 'no-such-token']) {
      const res = await accept(token, 'probe@example.test');
      expect(res.statusCode).toBe(400);
      bodies.push(res.json().error.code);
    }
    expect(new Set(bodies)).toEqual(new Set(['invite_invalid']));
    expect(await dbState(ctx.schema)).toEqual(before);
  });

  it('이미 있는 이메일은 같은 오류로 거부되고 token을 소비하지 않는다(NC-20)', async () => {
    const invite = await issue();
    const dup = await accept(invite.token, 'MEMBER@example.test');
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe('invite_invalid');
    expect((await accept(invite.token, 'fresh@example.test')).statusCode).toBe(201);
  });

  it('정책 미달 비밀번호·잘못된 본문은 계정을 만들지 않고 token을 소비하지 않는다', async () => {
    const invite = await issue();
    const weak = await accept(invite.token, 'weak@example.test', 'short');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('password_policy');
    const bad = await call(ctx.app, 'POST', '/api/invites/accept', undefined, { token: invite.token, email: 'x@example.test' });
    expect(bad.statusCode).toBe(400);
    expect(await userCount('weak@example.test')).toBe(0);
    expect((await accept(invite.token, 'weak@example.test')).statusCode).toBe(201);
  });

  it('잘못된 초대 id 폐기는 400이다', async () => {
    expect((await call(ctx.app, 'POST', '/api/invites/not-a-uuid/revoke', owner)).statusCode).toBe(400);
  });

  it('GET /api/members는 활성 멤버만 돌려주고 세션이 없으면 401이다', async () => {
    const res = await call(ctx.app, 'GET', '/api/members', owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().members.map((m: { role: string }) => m.role).sort()).toEqual(['member', 'owner']);
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.memberId]);
    const after = await call(ctx.app, 'GET', '/api/members', owner);
    expect(after.json().members).toEqual([{ id: ctx.ownerId, display_name: 'owner', role: 'owner' }]);
    expect((await call(ctx.app, 'GET', '/api/members')).statusCode).toBe(401);
  });
});
