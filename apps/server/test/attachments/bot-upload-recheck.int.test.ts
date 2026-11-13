import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BOT_UPLOAD_BYTES_PER_DAY, createBotRateLimiter } from '../../src/modules/bots/index.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { count, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { png } from './att-harness.js';

/**
 * W-26 Codex r2: 봇 업로드 선행 인증(onRequest)의 빈틈.
 * ① 본문을 기다리는 사이 토큰 폐기·봇 비활성화·채널 제거가 일어나면 본문 수신 뒤 다시 판정해 401·404, 저장 0.
 * ② Content-Length 없는(chunked) 요청도 일일 바이트를 다 쓴 토큰이면 본문을 기다리지 않고 429.
 */
let lc: BotListenerContext | undefined;

afterEach(async () => {
  await teardownBotListener(lc);
  lc = undefined;
});

const SETTLE_MS = 300;
const EARLY_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stored = (ctx: BotListenerContext) => count(ctx, 'SELECT count(*)::int AS n FROM attachments WHERE uploader_id = $1', [ctx.bot.botUserId]);

interface PendingUpload {
  /** 본문을 보내고 응답 상태를 돌려준다. */
  finish(): Promise<number>;
}

function startUpload(ctx: BotListenerContext, conversationId: string, bytes: Buffer, chunked: boolean): { req: ClientRequest; status: Promise<number> } {
  const port = ctx.botPort;
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/api/bot/v1/attachments?conversation_id=${conversationId}`,
    headers: {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${ctx.token}`,
      'content-type': 'image/png',
      ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(bytes.length) }),
    },
  });
  const status = new Promise<number>((resolve, reject) => {
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
  req.flushHeaders();
  return { req, status };
}

/** 유효한 헤더만 먼저 보내고(onRequest 판정 통과) 본문은 `finish()` 때 보낸다. */
async function delayedUpload(ctx: BotListenerContext, conversationId: string): Promise<PendingUpload> {
  const bytes = png();
  const { req, status } = startUpload(ctx, conversationId, bytes, false);
  await sleep(SETTLE_MS);
  return {
    finish: () => {
      req.end(bytes);
      return status;
    },
  };
}

async function botChannel(ctx: BotListenerContext): Promise<{ channel: string; remove: () => Promise<number> }> {
  const app = ctx.conv.app;
  const owner = await as(app, 'a');
  const channel = await createChannel(app, owner, 'upload-room');
  expect((await req(app, 'POST', `/api/conversations/${channel}/bots`, owner, { bot_user_id: ctx.bot.botUserId })).statusCode).toBe(201);
  return { channel, remove: async () => (await req(app, 'DELETE', `/api/conversations/${channel}/bots/${ctx.bot.botUserId}`, owner)).statusCode };
}

describe('봇 업로드 — 본문 수신 뒤 권한 재판정', () => {
  it('본문 대기 중 토큰을 폐기하면 본문 완료 시 401이고 저장 0', async () => {
    lc = await setupBotListener();
    const pending = await delayedUpload(lc, lc.bot.dmConversationId);
    expect((await lc.service.revokeToken(lc.tokenId)).revoked).toBe(true);
    expect(await pending.finish()).toBe(401);
    expect(await stored(lc)).toBe(0);
  });

  it('본문 대기 중 봇을 비활성화하면 본문 완료 시 401이고 저장 0', async () => {
    lc = await setupBotListener();
    const pending = await delayedUpload(lc, lc.bot.dmConversationId);
    await lc.service.disableBot(lc.bot.botUserId);
    expect(await pending.finish()).toBe(401);
    expect(await stored(lc)).toBe(0);
  });

  it('본문 대기 중 채널에서 봇을 제거하면 본문 완료 시 404이고 저장 0', async () => {
    lc = await setupBotListener();
    const room = await botChannel(lc);
    const pending = await delayedUpload(lc, room.channel);
    expect(await room.remove()).toBe(204);
    expect(await pending.finish()).toBe(404);
    expect(await stored(lc)).toBe(0);
  });

  it('권한이 그대로면 지연된 본문도 201로 저장된다(회귀)', async () => {
    lc = await setupBotListener();
    const room = await botChannel(lc);
    const pending = await delayedUpload(lc, room.channel);
    expect(await pending.finish()).toBe(201);
    expect(await stored(lc)).toBe(1);
  });
});

describe('봇 업로드 — chunked 요청의 일일 바이트 선행 판정', () => {
  it('일일 100 MiB를 다 쓰고 분당 창은 빈 토큰이 chunked 헤더만 보내면 본문 대기 없이 429', async () => {
    let now = 0;
    const limiter = createBotRateLimiter(() => now);
    lc = await setupBotListener({ limiter });
    expect(limiter.takeUploadBytes(lc.tokenId, BOT_UPLOAD_BYTES_PER_DAY).ok).toBe(true);
    now += 61_000; // 분당 건수 창은 비어 있다(바이트는 24시간 창).
    const { req, status } = startUpload(lc, lc.bot.dmConversationId, Buffer.alloc(0), true);
    const early = await Promise.race([status, sleep(EARLY_MS).then(() => 'timeout' as const)]);
    req.destroy();
    expect(early).toBe(429);
    expect(await stored(lc)).toBe(0);
  });

  it('일일 잔여가 있으면 chunked 업로드는 받은 바이트로 집계해 201(회귀)', async () => {
    let now = 0;
    const limiter = createBotRateLimiter(() => now);
    lc = await setupBotListener({ limiter });
    const bytes = png();
    expect(limiter.takeUploadBytes(lc.tokenId, BOT_UPLOAD_BYTES_PER_DAY - bytes.length).ok).toBe(true);
    now += 61_000;
    const { req, status } = startUpload(lc, lc.bot.dmConversationId, bytes, true);
    req.end(bytes);
    expect(await status).toBe(201);
    expect(await stored(lc)).toBe(1);
    // 받은 바이트로 집계됐으므로 남은 일일 바이트는 0이다.
    expect(limiter.takeUploadBytes(lc.tokenId, 1).ok).toBe(false);
  });
});
