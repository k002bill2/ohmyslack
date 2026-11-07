import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { send, sendRaw } from '../messages/msg-int-harness.js';
import { conversations, markRead, summary } from './sync-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await teardownConvInt(ctx);
});

describe('unread 집계', () => {
  it('FR-SYNC-05 자기 메시지·삭제 메시지·자기 멘션은 본문·스레드 unread와 멘션 집계에서 빠지고 읽지 않은 메시지가 삭제되면 배지가 남지 않으며 재수신해도 중복 집계되지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, b);

    const fromA = await send(ctx.app, a, general, { body: 'A 원문' });
    await send(ctx.app, b, general, { body: 'B 자기 원문', mention_user_ids: [ctx.ids.b] }); // 자기 메시지·자기 멘션
    const mentionB = await send(ctx.app, a, general, { body: '@B', mention_user_ids: [ctx.ids.b] });
    const doomed = await send(ctx.app, a, general, { body: '곧 삭제', mention_user_ids: [ctx.ids.b] });
    // 스레드: B가 답글을 써 대상이 되고, A 답글 2개 중 1개는 삭제, B 자기 답글은 제외.
    await send(ctx.app, b, general, { body: 'B 답글', thread_root_id: fromA.id });
    const keep = await send(ctx.app, a, general, { body: 'A 답글', thread_root_id: fromA.id, mention_user_ids: [ctx.ids.b] });
    const gone = await send(ctx.app, a, general, { body: 'A 삭제 답글', thread_root_id: fromA.id, mention_user_ids: [ctx.ids.b] });

    let s = await summary(ctx.app, b, general);
    expect(s.unread_count).toBe(3); // fromA, mentionB, doomed (B 원문 제외, 답글은 본문에 합산하지 않음)
    expect(s.mention_count).toBe(4); // mentionB, doomed, keep, gone
    expect(s.unread_threads).toEqual([
      { root_message_id: fromA.id, last_read_seq: 0, last_reply_seq: gone.seq, unread_reply_count: 2, mention_count: 2 },
    ]);
    expect(s.unread_thread_count).toBe(1);

    // 읽지 않은 메시지 삭제 → 배지 남지 않음.
    for (const id of [doomed.id, gone.id]) expect((await req(ctx.app, 'DELETE', `/api/messages/${id}`, a)).statusCode).toBe(200);
    s = await summary(ctx.app, b, general);
    expect(s.unread_count).toBe(2);
    expect(s.mention_count).toBe(2);
    expect(s.unread_threads).toEqual([
      { root_message_id: fromA.id, last_read_seq: 0, last_reply_seq: keep.seq, unread_reply_count: 1, mention_count: 1 },
    ]);

    // 재수신(같은 멱등 키 재시도)은 중복 집계하지 않는다.
    const cmid = randomUUID();
    await send(ctx.app, a, general, { client_message_id: cmid, body: '한 번만', mention_user_ids: [ctx.ids.b] });
    expect((await sendRaw(ctx.app, a, general, { client_message_id: cmid, body: '한 번만', mention_user_ids: [ctx.ids.b] })).statusCode).toBe(200);
    s = await summary(ctx.app, b, general);
    expect(s.unread_count).toBe(3);
    expect(s.mention_count).toBe(3);

    // 작성자 A 쪽은 자기 메시지만 있으므로 0(B 메시지 1개만 unread, 멘션 0).
    const sa = await summary(ctx.app, a, general);
    expect(sa.unread_count).toBe(1);
    expect(sa.mention_count).toBe(0);
    expect(sa.unread_threads).toEqual([
      { root_message_id: fromA.id, last_read_seq: 0, last_reply_seq: keep.seq, unread_reply_count: 1, mention_count: 0 },
    ]);
    expect(mentionB.mention_user_ids).toEqual([ctx.ids.b]);
  });

  it('GET /api/conversations 집계는 대화 수와 무관하게 고정 개수 쿼리로 끝난다(N+1 없음)', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const count = async (): Promise<number> => {
      const spy = vi.spyOn(ctx.schema.pool, 'query');
      await conversations(ctx.app, b);
      const n = spy.mock.calls.length;
      spy.mockRestore();
      return n;
    };
    const first = await createChannel(ctx.app, a, 'c0');
    await req(ctx.app, 'POST', `/api/conversations/${first}/join`, b);
    const root = await send(ctx.app, a, first, { body: 'x', mention_user_ids: [ctx.ids.b] });
    await send(ctx.app, b, first, { body: 'y', thread_root_id: root.id });
    await send(ctx.app, a, first, { body: 'z', thread_root_id: root.id });
    const one = await count();
    for (let i = 1; i <= 6; i += 1) {
      const ch = await createChannel(ctx.app, a, `c${i}`);
      await req(ctx.app, 'POST', `/api/conversations/${ch}/join`, b);
      const r = await send(ctx.app, a, ch, { body: 'x', mention_user_ids: [ctx.ids.b] });
      await send(ctx.app, b, ch, { body: 'y', thread_root_id: r.id });
      await send(ctx.app, a, ch, { body: 'z', thread_root_id: r.id });
    }
    const seven = await count();
    expect((await conversations(ctx.app, b)).filter((c) => c.unread_thread_count === 1)).toHaveLength(7);
    expect(seven).toBe(one);
    // 인증(세션 조회·연장) + 목록 1문장 이하로 고정.
    expect(one).toBeLessThanOrEqual(4);
    await markRead(ctx.app, b, first, root.seq);
  });
});
