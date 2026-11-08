import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindGuardError } from '../../src/bind.js';
import { buildBotApp, listenBot, resolveBotPort } from '../../src/modules/bots/index.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { as } from '../conversations/conv-int-harness.js';
import { bot, http, main, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';
import { connectBot, probeBotUpgrade, wsKey } from './bot-ws-harness.js';

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

  it('봇 리스너에는 /api/bot/v1/** bot 메타 라우트 9개(WS 포함)만 있고 그 밖·사람 전용 경로는 404다', async () => {
    const routes = ctx.botApp.botAccessRoutes ?? [];
    const keys = [...new Set(routes.filter((r) => r.method !== 'HEAD').map((r) => `${r.method} ${r.url}`))].sort();
    expect(keys).toEqual(
      [
        'GET /api/bot/v1/conversations/:id/messages',
        'GET /api/bot/v1/me',
        'GET /api/bot/v1/messages/:id/replies',
        'GET /api/bot/v1/sync',
        'GET /api/bot/v1/sync/snapshot',
        'GET /api/bot/v1/ws',
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

  it('봇 WS 업그레이드는 Origin·Cookie 동봉이면 400, Bearer 없음·사람 세션 쿠키면 거부되고 서버가 소켓을 닫는다', async () => {
    const auth = { authorization: `Bearer ${ctx.token}` };
    const human = await as(ctx.conv.app, 'a');
    const cases: [Record<string, string>, string][] = [
      [{ ...auth, origin: 'https://ohmy.test' }, '400'],
      [{ ...auth, cookie: `${SESSION_COOKIE}=${human.token}` }, '400'],
      [{ cookie: `${SESSION_COOKIE}=${human.token}` }, '400'],
      [{}, '401'],
      [{ authorization: 'Bearer omsb_fixture-not-a-real-token' }, '401'],
    ];
    for (const [headers, status] of cases) {
      const probe = await probeBotUpgrade(ctx.botPort, headers);
      expect(probe.statusLine, JSON.stringify(Object.keys(headers))).toContain(` ${status} `);
      expect(probe.closedMs, JSON.stringify(Object.keys(headers))).not.toBeNull();
    }
    const ok = await connectBot(ctx.botPort, ctx.token);
    expect(ok).not.toBe('rejected');
    if (ok !== 'rejected') ok.close();
  });

  it('메인 리스너 WS는 봇 Bearer로 열리지 않는다', async () => {
    const probe = await http(ctx.mainPort, 'GET', '/api/ws', {
      host: 'ohmy.test',
      origin: 'https://ohmy.test',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': wsKey(),
      authorization: `Bearer ${ctx.token}`,
    }).catch(() => ({ status: 0 }));
    expect([0, 401]).toContain(probe.status);
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
