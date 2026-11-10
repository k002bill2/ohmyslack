import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WsServerFrame } from '../../src/shared.js';
import { png, uploadedId } from '../attachments/att-harness.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { bot as botCall, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';
import { connectedBot, subscribeBot } from './bot-ws-harness.js';

/** 봇 읽기 범위·멤버십 통지(정본: BOT_CHANNEL_SPEC §4-3·§4-5, DEV_DESIGN 6-6 FR-BOT-09). */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

type Session = Awaited<ReturnType<typeof as>>;

async function post(owner: Session, channel: string, body: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await req(lc.conv.app, 'POST', `/api/conversations/${channel}/messages`, owner, { client_message_id: randomUUID(), body, ...extra });
  expect(res.statusCode, body).toBe(201);
  return res.json<{ message: { id: string } }>().message.id;
}

/** 프레임이 가리키는 메시지 id(메시지 이벤트만). */
function frameMessageId(f: WsServerFrame): string | undefined {
  if (f.type === 'message.created' || f.type === 'message.updated') return f.message.id;
  if (f.type === 'message.deleted') return f.message_id;
  return undefined;
}

const ids = (items: readonly { id: string }[]): string[] => items.map((m) => m.id);

describe('봇 채널 읽기 범위', () => {
  it('FR-BOT-09 채널에 추가된 봇은 참여 이후 메시지만 이력·답글·snapshot·sync·WS replay·WS 실시간·첨부로 받고 참여 전 루트에 달린 새 답글과 루트 재전송도 받지 않으며 추가·제거 때 봇 연결에 멤버십 변화 프레임이 한 번 온다', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const member = await as(app, 'b');
    const channel = await createChannel(app, owner, 'scope-room');
    await req(app, 'POST', `/api/conversations/${channel}/join`, member);
    const preFile = await uploadedId(app, owner, channel, png(), 'image/png');
    const preRoot = await post(owner, channel, '참여 전 루트', { attachment_ids: [preFile] });
    const preTop = await post(owner, channel, '참여 전 공지');
    const preReply = await post(owner, channel, '참여 전 답글', { thread_root_id: preRoot });

    const ws = await connectedBot(lc.botPort, lc.token);
    expect((await req(app, 'POST', `/api/conversations/${channel}/bots`, owner, { bot_user_id: lc.bot.botUserId })).statusCode).toBe(201);
    await ws.waitFor((f) => f.type === 'membership.changed' && f.state === 'joined' && f.conversation_id === channel);
    expect((await subscribeBot(ws, channel)).type).toBe('conversation.subscribed');

    // 참여 후: 새 루트(첨부)·참여 전 루트에 새 답글(루트 재전송 유발)·새 루트의 답글·참여 전 루트 수정·참여 전 글 삭제.
    const postFile = await uploadedId(app, owner, channel, png(), 'image/png');
    const postRoot = await post(owner, channel, '참여 후 루트', { attachment_ids: [postFile] });
    const lateReply = await post(owner, channel, '참여 전 스레드의 새 답글', { thread_root_id: preRoot });
    const postReply = await post(owner, channel, '참여 후 답글', { thread_root_id: postRoot });
    expect((await req(app, 'PATCH', `/api/messages/${preRoot}`, owner, { body: '참여 전 루트 수정' })).statusCode).toBe(200);
    expect((await req(app, 'DELETE', `/api/messages/${preTop}`, owner)).statusCode).toBe(200);
    const sentinel = await post(owner, channel, '마지막');
    await ws.waitFor((f) => frameMessageId(f) === sentinel);

    const hidden = [preRoot, preTop, preReply, lateReply];
    const visible = [postRoot, postReply, sentinel];
    // ⑥ WS 실시간: 숨김 메시지 이벤트 0(루트 재전송 포함), 참여 후 메시지는 도착.
    const live = ws.frames.map(frameMessageId).filter((id): id is string => id !== undefined);
    expect(live.filter((id) => hidden.includes(id))).toEqual([]);
    expect(new Set(live)).toEqual(new Set(visible));
    expect(JSON.stringify(ws.frames).includes('참여 전')).toBe(false);

    // ⑤ WS replay: 새 연결이 처음부터 재생해도 참여 후 메시지만.
    const ws2 = await connectedBot(lc.botPort, lc.token);
    expect((await subscribeBot(ws2, channel, 0)).type).toBe('conversation.subscribed');
    const replayed = ws2.frames.map(frameMessageId).filter((id): id is string => id !== undefined);
    expect(new Set(replayed)).toEqual(new Set(visible));

    // ① 이력 ② 답글 ③ snapshot ④ sync ⑦ 첨부.
    expect(ids((await botCall(lc, 'GET', `conversations/${channel}/messages`)).json.messages)).toEqual([postRoot, sentinel]);
    // 숨김 원문만 있는 앞 페이지는 서버가 건너뛴다(after_seq 진행, Codex P2).
    expect(ids((await botCall(lc, 'GET', `conversations/${channel}/messages?after_seq=0&limit=1`)).json.messages)).toEqual([postRoot]);
    expect((await botCall(lc, 'GET', `messages/${preRoot}/replies`)).status).toBe(404);
    expect((await botCall(lc, 'GET', `messages/${postRoot.toUpperCase()}/replies`)).status).toBe(200);
    expect(ids((await botCall(lc, 'GET', `messages/${postRoot}/replies`)).json.replies)).toEqual([postReply]);
    expect(new Set(ids((await botCall(lc, 'GET', `sync/snapshot?conversation_id=${channel}`)).json.messages))).toEqual(new Set(visible));
    const sync = (await botCall(lc, 'GET', 'sync?after=0')).json.changes as { conversation_id: string; message: { id: string } }[];
    expect(new Set(sync.filter((c) => c.conversation_id === channel).map((c) => c.message.id))).toEqual(new Set(visible));
    expect((await botCall(lc, 'GET', `attachments/${preFile}`)).status).toBe(404);
    expect((await botCall(lc, 'GET', `attachments/${postFile}`)).status).toBe(200);

    // 사람 읽기 범위 변화 0: 같은 채널의 사람 멤버는 참여 전 글과 스레드를 그대로 본다.
    const human = (await req(app, 'GET', `/api/conversations/${channel}/messages`, member)).json<{ messages: { id: string }[] }>();
    expect(ids(human.messages)).toEqual([preRoot, preTop, postRoot, sentinel]);
    expect((await req(app, 'GET', `/api/messages/${preRoot}/replies`, member)).statusCode).toBe(200);

    // 제거: left 프레임 1회. 추가·제거 각각 한 번씩만.
    expect((await req(app, 'DELETE', `/api/conversations/${channel}/bots/${lc.bot.botUserId}`, owner)).statusCode).toBe(204);
    await ws.waitFor((f) => f.type === 'membership.changed' && f.state === 'left');
    const changes = ws.frames.filter((f) => f.type === 'membership.changed');
    expect(changes).toEqual([
      { type: 'membership.changed', conversation_id: channel, state: 'joined' },
      { type: 'membership.changed', conversation_id: channel, state: 'left' },
    ]);
    ws.close();
    ws2.close();
  });
});
