import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WsServerFrame } from '../../src/shared.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { send, sendRaw } from '../messages/msg-int-harness.js';
import { setupWsInt, subscribe, type WsIntContext } from './ws-int-harness.js';

/** TRD §4: 답글 생성·삭제는 원문의 root_reply_count를 갱신해 같은 대화 구독자에게 live로 반영한다(삭제된 답글 제외). */
let ctx: WsIntContext;

beforeEach(async () => {
  ctx = await setupWsInt();
});

afterEach(async () => {
  await ctx.teardown();
});

const rootUpdate = (rootId: string, count: number, from: number, frames: readonly WsServerFrame[]) => (f: WsServerFrame) =>
  frames.indexOf(f) >= from && f.type === 'message.updated' && f.message.id === rootId && f.message.root_reply_count === count;

describe('스레드 답글 수 live 팬아웃', () => {
  it('답글 생성 뒤 구독자는 원문 message.updated(root_reply_count 1)를, 답글 삭제 뒤 0을 답글과 같은 change_id로 받는다', async () => {
    const app = ctx.conv.app;
    const a = await as(app, 'a');
    const b = await as(app, 'b');
    const general = await createChannel(app, a, 'general');
    expect((await req(app, 'POST', `/api/conversations/${general}/join`, b)).statusCode).toBe(200);
    const root = await send(app, a, general, { body: '원문' });
    const wsB = await ctx.open(b.token);
    expect(await subscribe(wsB, general)).toMatchObject({ type: 'conversation.subscribed' });

    const fromCreate = wsB.frames.length;
    const created = await sendRaw(app, a, general, { body: '답글', thread_root_id: root.id });
    expect(created.statusCode).toBe(201);
    const reply = created.json<{ message: { id: string }; change_id: number }>();
    const up = await wsB.waitFor(rootUpdate(root.id, 1, fromCreate, wsB.frames), 2000);
    expect(up).toMatchObject({ conversation_id: general, change_id: reply.change_id });
    // 답글 프레임이 원문 갱신보다 먼저 온다.
    const replyFrame = wsB.frames.findIndex((f, i) => i >= fromCreate && f.type === 'message.created' && f.message.id === reply.message.id);
    expect(replyFrame).toBeGreaterThanOrEqual(fromCreate);
    expect(replyFrame).toBeLessThan(wsB.frames.indexOf(up));

    const fromDelete = wsB.frames.length;
    const deleted = await req(app, 'DELETE', `/api/messages/${reply.message.id}`, a);
    expect(deleted.statusCode).toBe(200);
    const down = await wsB.waitFor(rootUpdate(root.id, 0, fromDelete, wsB.frames), 2000);
    expect(down).toMatchObject({ conversation_id: general, change_id: deleted.json<{ change_id: number }>().change_id });
    const deletedFrame = wsB.frames.findIndex((f, i) => i >= fromDelete && f.type === 'message.deleted' && f.message_id === reply.message.id);
    expect(deletedFrame).toBeGreaterThanOrEqual(fromDelete);
    expect(deletedFrame).toBeLessThan(wsB.frames.indexOf(down));
  });
});
