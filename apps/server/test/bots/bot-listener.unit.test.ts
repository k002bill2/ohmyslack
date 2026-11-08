import { describe, expect, it } from 'vitest';
import { createBotRateLimiter } from '../../src/modules/bots/rate-limit.js';
import { buildBotApp } from '../../src/modules/bots/listener.js';
import type { BotService } from '../../src/modules/bots/service.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import type { MessagesService } from '../../src/modules/messages/service.js';
import type { SyncService } from '../../src/modules/sync/service.js';

/** 봇 리스너 Host·헤더 가드와 rate limit 창(TRD §5-2 3·4·7항). DB 없이 inject로. */
const meOnly = { verifyToken: async () => ({ botUserId: '00000000-0000-4000-8000-000000000001', tokenId: 't' }), me: async () => ({ ownerUserId: '00000000-0000-4000-8000-000000000002', conversationIds: [] }) } as unknown as BotService;

function app(port: number) {
  return buildBotApp({
    bots: meOnly,
    conversations: {} as ConversationsService,
    messages: {} as MessagesService,
    sync: {} as SyncService,
    logger: { log: () => undefined },
    port,
  });
}

const auth = { authorization: `Bearer omsb_${'A'.repeat(43)}` };

describe('봇 리스너 요청 가드', () => {
  it('BOT_PORT=80이면 기본 포트가 정규화된 Host도 허용한다', async () => {
    const a = app(80);
    expect((await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: { host: '127.0.0.1:80', ...auth } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: { host: 'localhost', ...auth } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: { host: 'example.test', ...auth } })).statusCode).toBe(400);
    await a.close();
  });

  it('Origin 또는 Cookie가 있으면 인증 전에 400, Authorization 없으면 401', async () => {
    const a = app(4100);
    const host = { host: '127.0.0.1:4100' };
    const origin = await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: { ...host, ...auth, origin: 'http://127.0.0.1:4100' } });
    expect(origin.statusCode).toBe(400);
    const cookie = await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: { ...host, ...auth, cookie: 'x=1' } });
    expect(cookie.statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: host })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/bot/v1/me', headers: { ...host, authorization: 'Basic abc' } })).statusCode).toBe(401);
    await a.close();
  });
});

describe('봇 rate limit 창', () => {
  it('상한까지 허용, 초과는 거부·미기록, 60초 뒤 다시 허용, Retry-After는 가장 오래된 기록 기준', () => {
    let now = 1_000_000;
    const limiter = createBotRateLimiter(() => now);
    for (let i = 0; i < 30; i += 1) expect(limiter.take('t1', 'create').ok).toBe(true);
    now += 20_000;
    expect(limiter.take('t1', 'create')).toEqual({ ok: false, retryAfterSeconds: 40 });
    expect(limiter.take('t2', 'create').ok).toBe(true);
    for (let i = 0; i < 60; i += 1) expect(limiter.take('t1', 'edit').ok).toBe(true);
    expect(limiter.take('t1', 'edit').ok).toBe(false);
    now += 40_000;
    expect(limiter.take('t1', 'create').ok).toBe(true);
  });
});
