import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotEvents, createBotService, type CreatedBot } from '../../src/modules/bots/index.js';
import { as, openDm, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';

/**
 * 봇 참여 범위 경계(TRD §5-2 5항: owner DM + owner가 추가한 채널, Codex r1 P1·P2).
 * 봇 DM은 CLI create가 만드는 owner DM만, 봇 비활성화는 CLI disable만 — 사람 API는 없는 상대와 같은 거부.
 */
let ctx: ConvIntContext;
let bot: CreatedBot;

beforeEach(async () => {
  ctx = await setupConvInt();
  const service = createBotService({ pool: ctx.schema.pool, events: createBotEvents() });
  bot = await service.createBot({ displayName: 'Scope Bot', slug: 'scope-bot' });
  await service.issueToken(bot.botUserId, 'scope');
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

/** request_id는 요청마다 달라 비교에서 뺀다(나머지 본문·키는 같아야 한다). */
function shape(body: { error: Record<string, unknown> }): unknown {
  const { request_id: _id, ...rest } = body.error;
  return { keys: Object.keys(body.error).sort(), ...rest };
}

async function dmsWithBot(): Promise<number> {
  const res = await ctx.schema.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM conversations c
      WHERE c.kind = 'dm' AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1)`,
    [bot.botUserId],
  );
  return res.rows[0]?.n ?? -1;
}

describe('사람 API의 봇 범위 경계', () => {
  it('일반 멤버·owner 모두 봇 id로 DM을 열면 없는 상대와 같은 400이고 봇 DM은 CLI owner DM 1개뿐이다', async () => {
    expect(await dmsWithBot()).toBe(1);
    const unknown = await openDm(ctx.app, await as(ctx.app, 'b'), '00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(400);
    for (const who of ['b', 'a'] as const) {
      const res = await openDm(ctx.app, await as(ctx.app, who), bot.botUserId);
      expect(res.statusCode).toBe(unknown.statusCode);
      expect(shape(res.json())).toEqual(shape(unknown.json()));
    }
    expect(await dmsWithBot()).toBe(1);
    const owner = await ctx.schema.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
      [bot.dmConversationId],
    );
    expect(owner.rows[0]?.n).toBe(2);
  });

  it('owner가 봇 id로 원격 비활성화하면 없는 대상과 같은 404이고 상태·미폐기 토큰 수가 그대로다', async () => {
    const a = await as(ctx.app, 'a');
    const unknown = await req(ctx.app, 'POST', '/api/admin/members/00000000-0000-4000-8000-000000000000/deactivate', a);
    expect(unknown.statusCode).toBe(404);
    const res = await req(ctx.app, 'POST', `/api/admin/members/${bot.botUserId}/deactivate`, a);
    expect(res.statusCode).toBe(unknown.statusCode);
    expect(shape(res.json())).toEqual(shape(unknown.json()));
    const state = await ctx.schema.pool.query<{ status: string; live: number }>(
      `SELECT u.status, (SELECT count(*)::int FROM bot_tokens t WHERE t.bot_user_id = u.id AND t.revoked_at IS NULL) AS live
         FROM users u WHERE u.id = $1`,
      [bot.botUserId],
    );
    expect(state.rows[0]).toEqual({ status: 'active', live: 1 });
  });
});
