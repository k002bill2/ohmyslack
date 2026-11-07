import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReadUpdated } from '../../src/modules/sync/index.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { send } from '../messages/msg-int-harness.js';
import { markRead, summary } from './sync-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

const threadOf = async (who: Parameters<typeof summary>[1], conv: string, rootId: string) =>
  (await summary(ctx.app, who, conv)).unread_threads.find((t) => t.root_message_id === rootId);

describe('읽음 위치(PRD §7-7 합성 A/B/C)', () => {
  it('FR-SYNC-03 본문·스레드 읽음 위치가 따로 저장되고 스레드 대상은 원문·답글 작성·멘션 수신으로만 생기며 본문 열기만으로 답글이 읽음 처리되지 않고 다른 기기에서 같다', async () => {
    const a = await as(ctx.app, 'a');
    const b1 = await as(ctx.app, 'b');
    const b2 = await as(ctx.app, 'b');
    const c = await as(ctx.app, 'c');
    const general = await createChannel(ctx.app, a, 'general');
    for (const who of [b1, c]) await req(ctx.app, 'POST', `/api/conversations/${general}/join`, who);
    const events: ReadUpdated[] = [];
    ctx.app.readEvents.onUpdated((e) => events.push(e));

    // ① 무관한 스레드 → 답글 배지 없음: A 원문·A 답글, B는 대상 아님(스레드를 열어 보기만 해도 대상이 되지 않는다).
    const x = await send(ctx.app, a, general, { body: 'X' });
    const x1 = await send(ctx.app, a, general, { body: 'x1', thread_root_id: x.id });
    const x2 = await send(ctx.app, a, general, { body: 'x2', thread_root_id: x.id });
    await req(ctx.app, 'GET', `/api/messages/${x.id}/replies`, b1);
    expect(await threadOf(b1, general, x.id)).toBeUndefined();
    expect((await summary(ctx.app, b1, general)).unread_thread_count).toBe(0);

    // ② 원문 작성(B의 Y)·답글 작성(B가 X에)·멘션 수신(C가 Z 답글에서)으로 대상 편입.
    const y = await send(ctx.app, b1, general, { body: 'Y' });
    const y1 = await send(ctx.app, a, general, { body: 'y1', thread_root_id: y.id });
    expect(await threadOf(b1, general, y.id)).toMatchObject({ unread_reply_count: 1, last_reply_seq: y1.seq });
    const bx = await send(ctx.app, b1, general, { body: 'bx', thread_root_id: x.id });
    const z = await send(ctx.app, a, general, { body: 'Z' });
    expect(await threadOf(c, general, z.id)).toBeUndefined();
    const z1 = await send(ctx.app, a, general, { body: '@C', thread_root_id: z.id, mention_user_ids: [ctx.ids.c] });
    expect(await threadOf(c, general, z.id)).toMatchObject({ unread_reply_count: 1, mention_count: 1 });

    // ③ 최초 편입: 편입 전 미열람 답글(x1·x2)도 집계(B 자기 답글 bx 제외).
    expect(await threadOf(b1, general, x.id)).toMatchObject({ unread_reply_count: 2, last_read_seq: 0, last_reply_seq: bx.seq });

    // ④ 본문을 끝까지 읽어도 답글 배지 유지(본문 cursor와 스레드 cursor 분리).
    await markRead(ctx.app, b1, general, z.seq);
    const afterBody = await summary(ctx.app, b2, general);
    expect(afterBody.unread_count).toBe(0);
    expect(afterBody.unread_threads.map((t) => t.root_message_id).sort()).toEqual([x.id, y.id].sort());
    const thread = await ctx.schema.pool.query('SELECT 1 FROM thread_read_state WHERE user_id = $1', [ctx.ids.b]);
    expect(thread.rowCount).toBe(0);

    // ⑤ 한 기기에서 답글 열람 → 다른 기기도 같은 결과(서버 저장) + read.updated 발행.
    await markRead(ctx.app, b1, general, bx.seq, x.id);
    for (const device of [b1, b2]) expect(await threadOf(device, general, x.id)).toBeUndefined();
    expect((await summary(ctx.app, b2, general)).unread_threads.map((t) => t.root_message_id)).toEqual([y.id]);
    expect(events.at(-1)).toMatchObject({ userId: ctx.ids.b, conversationId: general, threadRootId: x.id, lastReadSeq: bx.seq });
    expect(events.at(-2)).toMatchObject({ userId: ctx.ids.b, conversationId: general, threadRootId: null, lastReadSeq: z.seq });

    // ⑥ 멘션 수정·삭제와 자기 메시지 제외: z1 멘션 제거 → C 멘션 0이지만 대상 자격 유지, 삭제 → 배지 없음, C 자기 답글 제외.
    expect((await req(ctx.app, 'PATCH', `/api/messages/${z1.id}`, a, { body: '멘션 제거', mention_user_ids: [] })).statusCode).toBe(200);
    expect(await threadOf(c, general, z.id)).toMatchObject({ unread_reply_count: 1, mention_count: 0 });
    expect((await summary(ctx.app, c, general)).mention_count).toBe(0);
    await send(ctx.app, c, general, { body: 'C 자기 답글', thread_root_id: z.id });
    expect(await threadOf(c, general, z.id)).toMatchObject({ unread_reply_count: 1 });
    expect((await req(ctx.app, 'DELETE', `/api/messages/${z1.id}`, a)).statusCode).toBe(200);
    expect(await threadOf(c, general, z.id)).toBeUndefined();
    const z2 = await send(ctx.app, a, general, { body: 'z2', thread_root_id: z.id });
    expect(await threadOf(c, general, z.id)).toMatchObject({ unread_reply_count: 1, last_reply_seq: z2.seq });
    expect(x2.seq).toBeGreaterThan(x1.seq);
  });

  it('접근을 잃으면 목록·집계에서 빠지고, 재참여 시 joined_seq 이전 답글은 스레드 unread가 되지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    const l = await as(ctx.app, 'l');
    const general = await createChannel(ctx.app, a, 'general');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, l);
    const root = await send(ctx.app, l, general, { body: 'L 원문' });
    await send(ctx.app, a, general, { body: 'r1', thread_root_id: root.id });
    expect(await threadOf(l, general, root.id)).toMatchObject({ unread_reply_count: 1 });
    await req(ctx.app, 'DELETE', `/api/conversations/${general}/membership`, l);
    const list = await req(ctx.app, 'GET', '/api/conversations', l);
    expect(list.body).not.toContain(general);
    await send(ctx.app, a, general, { body: 'r2', thread_root_id: root.id });
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, l);
    expect(await threadOf(l, general, root.id)).toBeUndefined();
    const r3 = await send(ctx.app, a, general, { body: 'r3', thread_root_id: root.id });
    expect(await threadOf(l, general, root.id)).toMatchObject({ unread_reply_count: 1, last_reply_seq: r3.seq });
  });
});
