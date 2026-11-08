import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildBotApp, createBotEvents, createBotService, listenBot, type BotService, type CreatedBot } from '../../src/modules/bots/index.js';
import { HOST } from '../support/auth-app.js';
import { setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';

/** 봇 리스너 통합 테스트: 메인 앱 + 봇 앱을 실제 루프백 포트(0=임시)로 띄우고 node:http로 헤더를 그대로 보낸다. */
export interface BotListenerContext {
  readonly conv: ConvIntContext;
  readonly botApp: FastifyInstance;
  readonly service: BotService;
  readonly bot: CreatedBot;
  readonly token: string;
  readonly tokenId: string;
  readonly botPort: number;
  readonly mainPort: number;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function setupBotListener(): Promise<BotListenerContext> {
  const conv = await setupConvInt();
  const service = createBotService({ pool: conv.schema.pool, events: createBotEvents() });
  const bot = await service.createBot({ displayName: 'Listener Bot', slug: 'listener-bot' });
  const issued = await service.issueToken(bot.botUserId, 'adapter');
  const services = conv.app.domainServices;
  if (services === undefined) throw new Error('도메인 서비스 없음');
  const botApp = buildBotApp({ bots: service, ...services, logger: { log: () => undefined } });
  const env = { HOST: '127.0.0.1' };
  const botAddress = await listenBot(botApp, env, 0);
  await conv.app.listen({ host: '127.0.0.1', port: 0 });
  const mainPort = (conv.app.server.address() as AddressInfo).port;
  return { conv, botApp, service, bot, token: issued.token, tokenId: issued.tokenId, botPort: botAddress.port, mainPort };
}

export async function teardownBotListener(ctx: BotListenerContext | undefined): Promise<void> {
  await ctx?.botApp.close();
  await teardownConvInt(ctx?.conv);
}

export function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text === '' ? undefined : JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** 봇 Bearer 요청. */
export function bot(ctx: BotListenerContext, method: string, path: string, body?: unknown, token = ctx.token): Promise<HttpResult> {
  return http(ctx.botPort, method, `/api/bot/v1/${path}`, { authorization: `Bearer ${token}` }, body);
}

/** 메인 리스너 요청(허용 Host). */
export function main(ctx: BotListenerContext, method: string, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return http(ctx.mainPort, method, path, { host: HOST, ...headers });
}

export async function count(ctx: BotListenerContext, sql: string, params: unknown[]): Promise<number> {
  const res = await ctx.conv.schema.pool.query<{ n: number }>(sql, params);
  return res.rows[0]?.n ?? -1;
}
