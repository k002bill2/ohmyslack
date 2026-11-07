import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { send } from '../messages/msg-int-harness.js';
import { markRead, markReadRaw, summary } from './sync-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

async function stored(conversationId: string, userId: string): Promise<number | undefined> {
  const res = await ctx.schema.pool.query<{ s: string }>(
    'SELECT last_read_seq::text AS s FROM conversation_read_state WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  return res.rows[0] === undefined ? undefined : Number(res.rows[0].s);
}

describe('읽음 병합', () => {
  it('재참여 뒤 joined_seq보다 낮은 스레드 읽음은 joined_seq로 올려 저장·응답한다', async () => {
    const a = await as(ctx.app, 'a');
    const l = await as(ctx.app, 'l');
    const general = await createChannel(ctx.app, a, 'general');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, l);
    const root = await send(ctx.app, l, general, { body: 'root' });
    const r1 = await send(ctx.app, a, general, { body: 'r1', thread_root_id: root.id });
    await req(ctx.app, 'DELETE', `/api/conversations/${general}/membership`, l);
    const r2 = await send(ctx.app, a, general, { body: 'r2', thread_root_id: root.id });
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, l);
    const res = await markRead(ctx.app, l, general, r1.seq, root.id);
    expect(res.last_read_seq).toBe(r2.seq);
  });

  it('FR-SYNC-06 오래된 읽음 위치가 늦게 도착해도 커서가 후퇴하지 않고 다른 대화·다른 스레드·실제 최대 seq 초과 위치는 400이며 최대 유효 위치로 수렴한다', async () => {
    const a = await as(ctx.app, 'a');
    const mac = await as(ctx.app, 'b');
    const phone = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    const other = await createChannel(ctx.app, a, 'other');
    for (const ch of [general, other]) await req(ctx.app, 'POST', `/api/conversations/${ch}/join`, mac);
    const r1 = await send(ctx.app, a, general, { body: '1' });
    const reply = await send(ctx.app, a, general, { body: 'r', thread_root_id: r1.id });
    const r2 = await send(ctx.app, a, general, { body: '2' });
    const r3 = await send(ctx.app, a, general, { body: '3' });
    const foreign = await send(ctx.app, a, other, { body: 'o' });
    const foreignReply = await send(ctx.app, a, other, { body: 'or', thread_root_id: foreign.id });

    // 최신 맥 읽음 → 오래된 휴대폰 읽음: 후퇴·배지 재증가 없음.
    expect((await markRead(ctx.app, mac, general, r3.seq)).last_read_seq).toBe(r3.seq);
    const late = await markRead(ctx.app, phone, general, r1.seq);
    expect(late.last_read_seq).toBe(r3.seq);
    const after = await summary(ctx.app, phone, general);
    expect(after.last_read_seq).toBe(r3.seq);
    expect(after.unread_count).toBe(0);

    // 범위 밖 위치는 400이고 저장 위치는 그대로다.
    const rejected = [
      await markReadRaw(ctx.app, mac, general, r3.seq + 1), // 실제 최대 원문 seq 초과
      await markReadRaw(ctx.app, mac, general, 1, foreign.id), // 다른 대화의 root
      await markReadRaw(ctx.app, mac, general, reply.seq, reply.id), // 답글은 root가 아니다(다른 스레드 위치)
      await markReadRaw(ctx.app, mac, general, reply.seq + 1, r1.id), // 스레드 실제 최대 답글 seq 초과
      await markReadRaw(ctx.app, mac, other, foreignReply.seq, r1.id), // 다른 대화의 스레드
      await markReadRaw(ctx.app, mac, general, -1),
    ];
    expect(rejected.map((r) => r.statusCode)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(await stored(general, ctx.ids.b)).toBe(r3.seq);
    expect((await summary(ctx.app, mac, general)).last_read_seq).toBe(r3.seq);

    // 다른 대화 읽음은 이 대화에 영향 없음, 스레드 읽음은 본문 cursor와 따로 저장된다.
    await markRead(ctx.app, mac, other, foreign.seq);
    await markRead(ctx.app, mac, general, reply.seq, r1.id);
    expect(await stored(general, ctx.ids.b)).toBe(r3.seq);

    // 동시 갱신: 순서와 무관하게 최대 유효 위치로 수렴.
    const seqs = [r1.seq, r3.seq, r2.seq, r1.seq, r2.seq, r3.seq];
    await Promise.all(seqs.map((s, i) => markRead(ctx.app, i % 2 === 0 ? mac : phone, general, s)));
    expect(await stored(general, ctx.ids.b)).toBe(r3.seq);
    for (const device of [mac, phone]) expect((await summary(ctx.app, device, general)).last_read_seq).toBe(r3.seq);
  });

  it('비참여자·나간 사용자는 읽음 404, 비활성 401, 형식 오류 400이며 상태가 바뀌지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    const general = await createChannel(ctx.app, a, 'general');
    const l = await as(ctx.app, 'l');
    const d = await as(ctx.app, 'd');
    for (const who of [l, d]) await req(ctx.app, 'POST', `/api/conversations/${general}/join`, who);
    const m = await send(ctx.app, a, general, { body: 'x' });
    await req(ctx.app, 'DELETE', `/api/conversations/${general}/membership`, l);
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
    const c = await as(ctx.app, 'c');
    const events: unknown[] = [];
    ctx.app.readEvents.onUpdated((e) => events.push(e));
    expect((await markReadRaw(ctx.app, c, general, m.seq)).statusCode).toBe(404);
    expect((await markReadRaw(ctx.app, l, general, m.seq)).statusCode).toBe(404);
    expect((await markReadRaw(ctx.app, d, general, m.seq)).statusCode).toBe(401);
    expect((await req(ctx.app, 'PUT', '/api/read-state', a, { last_read_seq: 1 })).statusCode).toBe(400);
    expect((await req(ctx.app, 'PUT', '/api/read-state', a, { conversation_id: general, last_read_seq: 'x' })).statusCode).toBe(400);
    expect(await stored(general, ctx.ids.c)).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
