import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { bot, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';

/** 봇 답글의 스레드 규칙(TRD §5-2 6항 + §3 1단 스레드). */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

const send = (body: string, threadRootId?: string) => ({ client_message_id: randomUUID(), body, ...(threadRootId === undefined ? {} : { thread_root_id: threadRootId }) });

describe('봇 답글 스레드', () => {
  it('FR-BOT-04 봇 토큰으로 만든 답글도 1단 스레드 규칙과 같은 대화 root만 허용하며 봇 답글은 root_reply_count와 스레드 unread 규칙을 따른다', async () => {
    const dm = lc.bot.dmConversationId;
    const owner = await as(lc.conv.app, 'a');
    const rootRes = await req(lc.conv.app, 'POST', `/api/conversations/${dm}/messages`, owner, send('지시'));
    expect(rootRes.statusCode).toBe(201);
    const rootId = rootRes.json<{ message: { id: string } }>().message.id;

    const reply = await bot(lc, 'POST', `conversations/${dm}/messages`, send('답', rootId));
    expect(reply.status).toBe(201);
    expect(reply.json.message.thread_root_id).toBe(rootId);
    expect(reply.json.message.author_kind).toBe('bot');

    // 답글의 답글(2단) → 400, 저장 0
    const nested = await bot(lc, 'POST', `conversations/${dm}/messages`, send('2단', reply.json.message.id));
    expect(nested.status).toBe(400);
    // 다른 대화의 root → 거부. 봇에게 보이지 않는 루트는 없는 루트·숨김 루트와 같은 404(BOT_CHANNEL_SPEC §4-5 ★ 2026-11-10, 이전 400)
    const channel = await createChannel(lc.conv.app, owner, 'other');
    const otherRoot = await req(lc.conv.app, 'POST', `/api/conversations/${channel}/messages`, owner, send('다른 대화'));
    const cross = await bot(lc, 'POST', `conversations/${dm}/messages`, send('교차', otherRoot.json<{ message: { id: string } }>().message.id));
    expect(cross.status).toBe(404);
    const stored = await lc.conv.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [dm]);
    expect(stored.rows[0]?.n).toBe(2);

    // root_reply_count: 봇 이력·replies·사람 이력 모두 1
    const history = await bot(lc, 'GET', `conversations/${dm}/messages`);
    expect(history.json.messages.map((m: { id: string; root_reply_count: number }) => [m.id, m.root_reply_count])).toEqual([[rootId, 1]]);
    const replies = await bot(lc, 'GET', `messages/${rootId}/replies`);
    expect(replies.status).toBe(200);
    expect(replies.json.root.root_reply_count).toBe(1);
    expect(replies.json.replies.map((m: { id: string }) => m.id)).toEqual([reply.json.message.id]);

    // owner의 스레드 unread: 봇 답글 1건이 unread, 읽음 처리 후 0
    const list = async () =>
      (await req(lc.conv.app, 'GET', '/api/conversations', owner)).json<{
        conversations: { id: string; unread_thread_count: number; unread_threads: { root_message_id: string; unread_reply_count: number }[] }[];
      }>().conversations.find((c) => c.id === dm);
    const unread = await list();
    expect(unread?.unread_thread_count).toBe(1);
    expect(unread?.unread_threads).toEqual([expect.objectContaining({ root_message_id: rootId, unread_reply_count: 1 })]);
    const read = await req(lc.conv.app, 'PUT', '/api/read-state', owner, { conversation_id: dm, thread_root_id: rootId, last_read_seq: reply.json.seq });
    expect(read.statusCode).toBe(200);
    expect((await list())?.unread_thread_count).toBe(0);
  });
});
