import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inviteCreateResponseSchema } from '../../src/shared.js';
import { acceptBody, call, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext, type Session } from '../auth/members-int-harness.js';

/**
 * NC-20·SECURITY_REVIEW_P1 F-3: 기존 이메일로 수락해도 초대 token은 소모된다(used_at COMMIT). 응답은 다른 무효 사유와 같은
 * `invite_invalid`라 구분되지 않고, token 하나로 이메일 존재 여부를 반복 조회할 수 없다.
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

async function issue(): Promise<{ id: string; token: string }> {
  const res = await call(ctx.app, 'POST', '/api/invites', owner);
  expect(res.statusCode).toBe(201);
  return inviteCreateResponseSchema.parse(res.json());
}

function accept(token: string, email: string) {
  return call(ctx.app, 'POST', '/api/invites/accept', undefined, acceptBody(token, email));
}

async function inviteRow(id: string): Promise<{ used: boolean; revoked: boolean }> {
  const res = await ctx.schema.pool.query<{ used: boolean; revoked: boolean }>(
    'SELECT used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites WHERE id = $1',
    [id],
  );
  return res.rows[0] ?? { used: false, revoked: false };
}

async function userCount(email: string): Promise<number> {
  const res = await ctx.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE email_norm = $1', [email]);
  return res.rows[0]?.n ?? -1;
}

describe('초대 수락 이메일 충돌 (NC-20, F-3)', () => {
  it('기존 이메일로 수락하면 invite_invalid이고 token이 소모되어 같은 token의 새 이메일 수락도 invite_invalid다', async () => {
    const invite = await issue();
    const dup = await accept(invite.token, 'MEMBER@example.test');
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe('invite_invalid');
    expect(await inviteRow(invite.id)).toEqual({ used: true, revoked: false });
    expect(await userCount('member@example.test')).toBe(1);

    const retry = await accept(invite.token, 'fresh@example.test');
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error.code).toBe('invite_invalid');
    expect(await userCount('fresh@example.test')).toBe(0);
  });

  it('충돌 응답은 무효 token 응답과 본문이 같다(구분 없음)', async () => {
    const invite = await issue();
    const dup = await accept(invite.token, 'owner@example.test');
    const unknown = await accept('no-such-token-value-000000000000000000000', 'x@example.test');
    expect(dup.statusCode).toBe(unknown.statusCode);
    const strip = (body: { error: { code: string } }) => body.error.code;
    expect(strip(dup.json())).toBe(strip(unknown.json()));
  });
});
