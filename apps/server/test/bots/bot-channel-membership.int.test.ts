import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, convState, createChannel, req } from '../conversations/conv-int-harness.js';
import { bot as botCall, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';
import { connectedBot, subscribeBot } from './bot-ws-harness.js';

/** 봇 채널 참여 라우트(정본: BOT_CHANNEL_SPEC §4-1·§4-2, DEV_DESIGN 6-6 FR-BOT-08). */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

const msg = (body: string) => ({ client_message_id: randomUUID(), body });

async function botMembers(conversationId: string): Promise<number> {
  const res = await lc.conv.schema.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
    [conversationId, lc.bot.botUserId],
  );
  return res.rows[0]?.n ?? -1;
}

describe('봇 채널 참여 — 추가·제거', () => {
  it('FR-BOT-08 owner만 참여 중인 공개 채널에 활성 봇을 추가·제거하고 일반 멤버·비참여자·DM·사람 대상 요청은 거부되며 제거 후 봇 이력·쓰기는 404이고 기존 구독은 끊긴다', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const member = await as(app, 'b');
    const outsider = await as(app, 'c');
    const channel = await createChannel(app, owner, 'bot-room');
    expect((await req(app, 'POST', `/api/conversations/${channel}/join`, member)).statusCode).toBe(200);
    const dm = (await req(app, 'POST', '/api/dms', owner, { user_id: lc.conv.ids.b })).json<{ id: string }>().id;
    const disabled = await lc.service.createBot({ displayName: 'Off Bot', slug: 'off-bot' });
    await lc.service.disableBot(disabled.botUserId);
    const path = `/api/conversations/${channel}/bots`;
    const body = { bot_user_id: lc.bot.botUserId };
    const before = await convState(lc.conv.schema);

    // 거부: 일반 멤버 403, 비참여자 404, DM 400, 사람·없는 사용자·비활성 봇 대상 404 — 모두 DB 변화 0.
    expect((await req(app, 'POST', path, member, body)).statusCode).toBe(403);
    expect((await req(app, 'DELETE', `${path}/${lc.bot.botUserId}`, member)).statusCode).toBe(403);
    expect((await req(app, 'POST', path, outsider, body)).statusCode).toBe(404);
    expect((await req(app, 'POST', `/api/conversations/${dm}/bots`, owner, body)).statusCode).toBe(400);
    for (const target of [lc.conv.ids.b, randomUUID(), disabled.botUserId, 'not-a-uuid']) {
      expect((await req(app, 'POST', path, owner, { bot_user_id: target })).statusCode, target).toBe(404);
    }
    expect(await convState(lc.conv.schema)).toEqual(before);
    // 봇 토큰으로 추가·제거하는 경로는 없다(봇 리스너 라우트 0).
    expect((await botCall(lc, 'POST', `conversations/${channel}/bots`, body)).status).toBe(404);
    expect((await botCall(lc, 'DELETE', `conversations/${channel}/bots/${lc.bot.botUserId}`)).status).toBe(404);
    expect(await botMembers(channel)).toBe(0);

    // 추가: 201, 재추가 200(멱등).
    expect((await req(app, 'POST', path, owner, body)).statusCode).toBe(201);
    expect((await req(app, 'POST', path, owner, body)).statusCode).toBe(200);
    expect(await botMembers(channel)).toBe(1);
    expect((await botCall(lc, 'GET', `conversations/${channel}/messages`)).status).toBe(200);
    const ws = await connectedBot(lc.botPort, lc.token);
    expect((await subscribeBot(ws, channel)).type).toBe('conversation.subscribed');

    // 제거: 204, 다시 제거 204(멱등). 사람 대상 제거는 사람 멤버십을 건드리지 않는다.
    const ended = lc.conv.ended.length;
    expect((await req(app, 'DELETE', `${path}/${lc.bot.botUserId}`, owner)).statusCode).toBe(204);
    expect((await req(app, 'DELETE', `${path}/${lc.bot.botUserId}`, owner)).statusCode).toBe(204);
    expect((await req(app, 'DELETE', `${path}/${lc.conv.ids.b}`, owner)).statusCode).toBe(204);
    expect(lc.conv.ended.slice(ended)).toEqual([[channel, lc.bot.botUserId]]);
    expect(await botMembers(channel)).toBe(0);
    expect((await req(app, 'GET', `/api/conversations/${channel}/messages`, member)).statusCode).toBe(200);
    // 제거 후 봇 이력·쓰기 404, 기존 구독은 5초 안에 not_found로 끊긴다.
    await ws.waitFor((f) => f.type === 'error' && 'conversation_id' in f && f.conversation_id === channel, 5_000);
    expect((await botCall(lc, 'GET', `conversations/${channel}/messages`)).status).toBe(404);
    expect((await botCall(lc, 'POST', `conversations/${channel}/messages`, msg('나간 뒤'))).status).toBe(404);
    ws.close();
  });
});
