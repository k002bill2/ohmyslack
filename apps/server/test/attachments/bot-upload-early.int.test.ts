import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_DOC_MAX_BYTES } from '../../src/shared.js';
import { botUpload, count, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { png } from './att-harness.js';

/**
 * SR-D-01 봇 경로(THREAT 델타): 봇 업로드도 사람 경로처럼 body를 받기 **전**(onRequest)에 토큰·업로드 상한을 판정한다.
 * 헤더만 보내고 body를 보내지 않아도 401·429가 먼저 와야 한다(수정 전: 25 MiB body를 기다리다 타임아웃).
 */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

const EARLY_MS = 2000;

/** 25 MiB Content-Length 헤더만 보내고 body는 보내지 않는다. EARLY_MS 안에 응답이 오면 상태 코드, 아니면 'timeout'. 끝나면 소켓을 닫는다. */
function headersOnly(port: number, conversationId: string, authorization?: string): Promise<number | 'timeout'> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/bot/v1/attachments?conversation_id=${conversationId}`,
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/pdf',
        'content-length': String(ATTACHMENT_DOC_MAX_BYTES),
        ...(authorization === undefined ? {} : { authorization }),
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve('timeout');
    }, EARLY_MS);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      req.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => undefined);
    req.flushHeaders();
  });
}

const stored = (ctx: BotListenerContext) => count(ctx, 'SELECT count(*)::int AS n FROM attachments WHERE uploader_id = $1', [ctx.bot.botUserId]);

describe('봇 업로드 — body 수신 전 판정(SR-D-01)', () => {
  it('Bearer 없이·잘못된 토큰으로 25 MiB 헤더만 보내면 body를 기다리지 않고 401이 먼저 온다', async () => {
    const dm = lc.bot.dmConversationId;
    expect(await headersOnly(lc.botPort, dm)).toBe(401);
    expect(await headersOnly(lc.botPort, dm, 'Bearer not-a-real-token')).toBe(401);
    expect(await stored(lc)).toBe(0);
  });

  it('인증된 봇이 1분 10건을 채우면 11번째는 헤더만으로 429가 먼저 온다', async () => {
    const dm = lc.bot.dmConversationId;
    for (let i = 0; i < 10; i += 1) expect((await botUpload(lc, dm, png(), 'image/png')).status).toBe(201);
    expect(await headersOnly(lc.botPort, dm, `Bearer ${lc.token}`)).toBe(429);
    expect(await stored(lc)).toBe(10);
  });
});
