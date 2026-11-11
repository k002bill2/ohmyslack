import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, main, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';

/** `GET /api/users/names`는 사람 리스너 전용: 봇 리스너(BOT_PORT)에는 없고, 봇 Bearer는 메인에서 세션으로 인정되지 않는다. */
let ctx: BotListenerContext;

beforeEach(async () => {
  ctx = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(ctx);
});

describe('GET /api/users/names 봇 경계', () => {
  it('봇 토큰으로 봇 리스너에 요청하면 404, 메인 리스너에 봇 Bearer만 보내면 401', async () => {
    const path = `/api/users/names?ids=${ctx.bot.botUserId}`;
    const onBot = await http(ctx.botPort, 'GET', path, { authorization: `Bearer ${ctx.token}` });
    expect(onBot.status).toBe(404);
    expect(ctx.conv.app.accessRoutes.some((r) => r.url === '/api/users/names')).toBe(true);
    const onMain = await main(ctx, 'GET', path, { authorization: `Bearer ${ctx.token}` });
    expect(onMain.status).toBe(401);
  });
});
