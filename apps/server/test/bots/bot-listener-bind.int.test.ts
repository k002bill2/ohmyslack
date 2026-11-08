import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindGuardError } from '../../src/bind.js';
import { buildBotApp, listenBot, resolveBotPort } from '../../src/modules/bots/index.js';
import { bot, http, main, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';

/** 봇 리스너 바인드·경로 경계(TRD §5-2 3항, DEV_DESIGN B9). */
let ctx: BotListenerContext;

beforeEach(async () => {
  ctx = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(ctx);
});

describe('봇 리스너 바인드·경로', () => {
  it('비루프백 HOST면 봇 리스너가 listen 전에 거부된다', async () => {
    const services = ctx.conv.app.domainServices;
    if (services === undefined) throw new Error('서비스 없음');
    for (const host of ['0.0.0.0', '::', '192.168.0.10', '100.64.0.1']) {
      const app = buildBotApp({ bots: ctx.service, ...services, logger: { log: () => undefined } });
      await expect(listenBot(app, { HOST: host }, 0)).rejects.toBeInstanceOf(BindGuardError);
      expect(app.server.listening).toBe(false);
      await app.close();
    }
    expect(ctx.botApp.server.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('봇 리스너에는 /api/bot/v1/** bot 메타 라우트 8개만 있고 그 밖·사람 전용 경로는 404다', async () => {
    const routes = ctx.botApp.botAccessRoutes ?? [];
    const keys = [...new Set(routes.filter((r) => r.method !== 'HEAD').map((r) => `${r.method} ${r.url}`))].sort();
    expect(keys).toEqual(
      [
        'GET /api/bot/v1/conversations/:id/messages',
        'GET /api/bot/v1/me',
        'GET /api/bot/v1/messages/:id/replies',
        'GET /api/bot/v1/sync',
        'GET /api/bot/v1/sync/snapshot',
        'PATCH /api/bot/v1/messages/:id',
        'POST /api/bot/v1/conversations/:id/messages',
        'PUT /api/bot/v1/read-state',
      ].sort(),
    );
    expect(routes.every((r) => r.access === 'bot' && r.url.startsWith('/api/bot/v1/'))).toBe(true);
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/healthz'],
      ['POST', '/api/bot/v1/dms'],
      ['POST', `/api/bot/v1/conversations/${ctx.bot.dmConversationId}/join`],
      ['GET', `/api/bot/v1/conversations/${ctx.bot.dmConversationId}/members`],
      ['DELETE', `/api/bot/v1/messages/${ctx.bot.dmConversationId}`],
      ['GET', '/'],
    ] as const) {
      const res = await http(ctx.botPort, method, path, { authorization: `Bearer ${ctx.token}` });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('메인 리스너에는 /api/bot/v1/* 라우트가 없다', async () => {
    expect(ctx.conv.app.accessRoutes.some((r) => r.url.startsWith('/api/bot/'))).toBe(false);
    const res = await main(ctx, 'GET', '/api/bot/v1/me', { authorization: `Bearer ${ctx.token}` });
    expect(res.status).toBe(404);
  });

  it('Host 허용목록 밖(다른 포트·외부 이름)은 400이고 localhost:<BOT_PORT>는 허용된다', async () => {
    const auth = { authorization: `Bearer ${ctx.token}` };
    expect((await http(ctx.botPort, 'GET', '/api/bot/v1/me', { ...auth, host: 'ohmy.test' })).status).toBe(400);
    expect((await http(ctx.botPort, 'GET', '/api/bot/v1/me', { ...auth, host: `127.0.0.1:${ctx.mainPort}` })).status).toBe(400);
    expect((await http(ctx.botPort, 'GET', '/api/bot/v1/me', { ...auth, host: `localhost:${ctx.botPort}` })).status).toBe(200);
    expect((await bot(ctx, 'GET', 'me')).status).toBe(200);
  });

  it('BOT_PORT 미설정·빈 값이면 봇 리스너를 띄우지 않고 PORT와 같거나 형식 오류면 기동 거부', () => {
    expect(resolveBotPort({}, 3000)).toBeUndefined();
    expect(resolveBotPort({ BOT_PORT: '' }, 3000)).toBeUndefined();
    expect(resolveBotPort({ BOT_PORT: '3001' }, 3000)).toBe(3001);
    expect(() => resolveBotPort({ BOT_PORT: '3000' }, 3000)).toThrow();
    expect(() => resolveBotPort({ BOT_PORT: 'abc' }, 3000)).toThrow();
    expect(() => resolveBotPort({ BOT_PORT: '70000' }, 3000)).toThrow();
  });
});
