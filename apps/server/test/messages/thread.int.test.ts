import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { history, replies, send, sendRaw } from './msg-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

describe('스레드', () => {
  it('FR-MSG-06 답글의 답글과 다른 대화 원문 답글은 거부되고 답글은 원문 이력에 섞이지 않으며 원문 삭제 후에도 남고 답글 수는 살아 있는 답글만 센다', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    const other = await createChannel(ctx.app, a, 'other');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, b);
    const root = await send(ctx.app, a, general, { body: '원문' });
    const foreignRoot = await send(ctx.app, a, other, { body: '다른 대화 원문' });
    const r1 = await send(ctx.app, b, general, { body: '답글1', thread_root_id: root.id });
    const r2 = await send(ctx.app, a, general, { body: '답글2', thread_root_id: root.id });
    const count = async (): Promise<number> => Number((await ctx.schema.pool.query<{ n: string }>('SELECT count(*) AS n FROM messages')).rows[0]?.n);
    const before = await count();

    // 답글의 답글, 다른 대화 원문에 대한 답글: 400, 저장 0.
    for (const threadRoot of [r1.id, foreignRoot.id]) {
      const res = await sendRaw(ctx.app, a, general, { body: 'x', thread_root_id: threadRoot });
      expect(res.statusCode).toBe(400);
    }
    expect(await count()).toBe(before);
    // 답글 ID로 답글 목록 요청도 거부된다.
    expect((await req(ctx.app, 'GET', `/api/messages/${r1.id}/replies`, a)).statusCode).toBe(400);

    // 원문 이력에는 원문만, 답글 수는 2.
    const page = await history(ctx.app, b, general);
    expect(page.messages.map((m) => m.id)).toEqual([root.id]);
    expect(page.messages[0]?.root_reply_count).toBe(2);

    // 답글 하나 삭제 → 답글 수 1(살아 있는 답글만), 원문 삭제 후에도 답글 남음.
    expect((await req(ctx.app, 'DELETE', `/api/messages/${r2.id}`, a)).statusCode).toBe(200);
    expect((await history(ctx.app, b, general)).messages[0]?.root_reply_count).toBe(1);
    expect((await req(ctx.app, 'DELETE', `/api/messages/${root.id}`, a)).statusCode).toBe(200);
    const after = await history(ctx.app, b, general);
    expect(after.messages.map((m) => [m.id, m.body, m.root_reply_count])).toEqual([[root.id, null, 1]]);
    const thread = await replies(ctx.app, b, root.id);
    expect(thread.root.root_reply_count).toBe(1);
    expect(thread.replies.map((r) => [r.id, r.body])).toEqual([
      [r1.id, '답글1'],
      [r2.id, null],
    ]);
    // 삭제된 원문에는 새 답글을 달 수 없다.
    expect((await sendRaw(ctx.app, b, general, { body: 'late', thread_root_id: root.id })).statusCode).toBe(400);
  });
});
