import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { membersResponseSchema } from '../../src/shared.js';
import { call, setupMembersInt, signIn, teardownMembersInt, type MembersIntContext, type Session } from '../auth/members-int-harness.js';

/** `GET /api/members` 항목의 `kind`(W-19b): `users.kind`를 그대로 싣는다 — 웹이 DM 후보·멤버 관리에서 봇을 가린다. */
let ctx: MembersIntContext;
let owner: Session;

beforeEach(async () => {
  ctx = await setupMembersInt();
  owner = await signIn(ctx.app, 'owner@example.test');
});

afterEach(async () => {
  await teardownMembersInt(ctx);
});

describe('GET /api/members kind', () => {
  it('사람은 kind human, 봇은 kind bot이며 기존 필드(id·display_name·role)는 그대로다', async () => {
    const botId = randomUUID();
    await ctx.schema.pool.query(
      "INSERT INTO users (id, email_norm, display_name, password_hash, status, kind) VALUES ($1, 'jarvis@bot.local', 'Jarvis', NULL, 'active', 'bot')",
      [botId],
    );
    await ctx.schema.pool.query("INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, $1, 'member' FROM workspaces LIMIT 1", [botId]);
    const res = await call(ctx.app, 'GET', '/api/members', owner);
    expect(res.statusCode).toBe(200);
    const body = membersResponseSchema.parse(res.json());
    expect(body.members.find((m) => m.id === botId)).toEqual({ id: botId, display_name: 'Jarvis', role: 'member', kind: 'bot' });
    expect(body.members.find((m) => m.id === ctx.ownerId)).toEqual({ id: ctx.ownerId, display_name: 'owner', role: 'owner', kind: 'human' });
    expect(body.members.find((m) => m.id === ctx.memberId)?.kind).toBe('human');
  });
});
