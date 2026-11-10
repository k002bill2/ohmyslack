import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WsServerFrame } from '../../src/shared.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';
import { connectedBot, subscribeBot } from './bot-ws-harness.js';

/** 채널 멘션 서버 측(정본: BOT_CHANNEL_SPEC §4·§5, DEV_DESIGN 6-6 FR-BOT-10). 어댑터 반응 규칙은 QA-FR-BOT-10. */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

type Created = Extract<WsServerFrame, { type: 'message.created' }>;

describe('봇 채널 멘션', () => {
  it('FR-BOT-10 채널에서 owner가 봇을 멘션하면 봇이 받는 message.created의 mention_user_ids에 봇 ID가 있고 멘션 없는 글과 비참여 봇에는 없다', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const joined = await createChannel(app, owner, 'mention-room');
    const other = await createChannel(app, owner, 'no-bot-room');
    expect((await req(app, 'POST', `/api/conversations/${joined}/bots`, owner, { bot_user_id: lc.bot.botUserId })).statusCode).toBe(201);
    const ws = await connectedBot(lc.botPort, lc.token);
    expect((await subscribeBot(ws, joined)).type).toBe('conversation.subscribed');
    expect((await subscribeBot(ws, other)).type).toBe('error');

    const send = (conv: string, body: string, mentions: string[]) =>
      req(app, 'POST', `/api/conversations/${conv}/messages`, owner, { client_message_id: randomUUID(), body, mention_user_ids: mentions });
    expect((await send(joined, '@Listener Bot 요약해 줘', [lc.bot.botUserId])).statusCode).toBe(201);
    expect((await send(joined, '그냥 잡담', [])).statusCode).toBe(201);
    // 비참여 채널: 봇 멘션 후보는 그 대화 멤버가 아니므로 서버가 걸러 내고, 봇에게는 이벤트도 없다.
    const outside = await send(other, '@Listener Bot 여기도?', [lc.bot.botUserId]);
    expect(outside.statusCode).toBe(201);
    expect(outside.json<{ message: { mention_user_ids: string[] } }>().message.mention_user_ids).not.toContain(lc.bot.botUserId);
    expect((await send(joined, '끝', [])).statusCode).toBe(201);
    await ws.waitFor((f) => f.type === 'message.created' && f.message.body === '끝');

    const created = ws.frames.filter((f): f is Created => f.type === 'message.created');
    expect(created.every((f) => f.conversation_id === joined)).toBe(true);
    const byBody = new Map(created.map((f) => [f.message.body, f.message.mention_user_ids]));
    expect(byBody.get('@Listener Bot 요약해 줘')).toEqual([lc.bot.botUserId]);
    expect(byBody.get('그냥 잡담')).toEqual([]);
    expect(byBody.has('@Listener Bot 여기도?')).toBe(false);
    ws.close();
  });
});
