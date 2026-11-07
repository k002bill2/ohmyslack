import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_RETENTION_ROWS } from '../../src/shared.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { send } from '../messages/msg-int-harness.js';
import { syncAll, syncPage } from './sync-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

describe('전역 sync', () => {
  it('첫 페이지 watermark 고정·페이지 스캔 상한·현재 멤버 대화만 payload·message id로 접기', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    const hidden = await createChannel(ctx.app, a, 'hidden');
    const left = await createChannel(ctx.app, a, 'left');
    for (const ch of [general, left]) await req(ctx.app, 'POST', `/api/conversations/${ch}/join`, b);
    const m1 = await send(ctx.app, a, general, { body: '1' });
    await send(ctx.app, a, hidden, { body: '숨김' });
    await send(ctx.app, a, left, { body: '나간 대화' });
    await req(ctx.app, 'PATCH', `/api/messages/${m1.id}`, a, { body: '1 수정' });
    await req(ctx.app, 'DELETE', `/api/conversations/${left}/membership`, b);

    const first = await syncPage(ctx.app, b, 'after=0&limit=2');
    expect(first.scanned_through).toBe(2);
    expect(first.has_more).toBe(true);
    const watermark = first.through_cursor;
    expect(watermark).toBe(4);
    // watermark 이후 변경은 이번 catch-up에 섞이지 않는다.
    await send(ctx.app, a, general, { body: '나중' });
    const { pages, texts } = await syncAll(ctx.app, b, first.next_cursor, 2, watermark);
    pages.unshift(first);
    expect(pages.every((p) => p.through_cursor === watermark)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ has_more: false, next_cursor: watermark, scanned_through: watermark });
    const all = pages.flatMap((p) => p.changes);
    expect(all.every((c) => c.conversation_id === general)).toBe(true);
    expect(texts.join('')).not.toContain('숨김');
    expect(texts.join('')).not.toContain('나간 대화');
    const m1Changes = all.filter((c) => c.message.id === m1.id);
    expect(m1Changes.at(-1)?.message.body).toBe('1 수정');
    // 같은 페이지 안의 같은 메시지는 하나로 접는다.
    const single = await syncPage(ctx.app, b, 'after=0&limit=500');
    expect(single.changes.filter((c) => c.message.id === m1.id)).toHaveLength(1);
    expect(single.changes.find((c) => c.message.id === m1.id)?.change_id).toBe(4);
    // 다음 동기화는 watermark 뒤부터 새 변경을 읽는다.
    const next = await syncPage(ctx.app, b, `after=${watermark}`);
    expect(next.changes.map((c) => c.message.body)).toEqual(['나중']);
    // 답글 생성·삭제만 있었던 구간도 원문의 현재 root_reply_count를 함께 싣는다.
    const cursor = next.through_cursor;
    const r1 = await send(ctx.app, a, general, { body: '답1', thread_root_id: m1.id });
    await send(ctx.app, a, general, { body: '답2', thread_root_id: m1.id });
    await req(ctx.app, 'DELETE', `/api/messages/${r1.id}`, a);
    const replyPage = await syncPage(ctx.app, b, `after=${cursor}`);
    const rootChange = replyPage.changes.find((c) => c.message.id === m1.id);
    expect(rootChange?.message.root_reply_count).toBe(1);
    expect(rootChange?.change_id).toBe(replyPage.through_cursor);
  });

  it('입력 범위 400·보존 경계 이전 cursor 410·비활성 401', async () => {
    const a = await as(ctx.app, 'a');
    const general = await createChannel(ctx.app, a, 'general');
    await send(ctx.app, a, general, { body: '1' });
    await send(ctx.app, a, general, { body: '2' });
    for (const q of ['', 'after=-1', 'after=0&limit=0', 'after=0&limit=501', 'after=2&through=1', 'after=0&through=99', 'after=99', 'after=0&x=1']) {
      expect((await req(ctx.app, 'GET', `/api/sync?${q}`, a)).statusCode, q).toBe(400);
    }
    expect((await req(ctx.app, 'GET', '/api/sync?after=0&limit=500', a)).statusCode).toBe(200);
    // 30일 경계: change 1이 31일 전이면 after=0은 만료, after=1은 유효.
    await ctx.schema.pool.query("UPDATE conversation_changes SET created_at = now() - interval '31 days' WHERE change_id = 1");
    const expired = await req(ctx.app, 'GET', '/api/sync?after=0', a);
    expect(expired.statusCode).toBe(410);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe('cursor_expired');
    expect((await req(ctx.app, 'GET', '/api/sync?after=1', a)).statusCode).toBe(200);
    // 100,000 row 경계: 마지막 change - 상수보다 앞선 cursor는 만료.
    await ctx.schema.pool.query('UPDATE sync_clock SET last_change_id = $1 WHERE id = 1', [SYNC_RETENTION_ROWS + 2]);
    expect((await req(ctx.app, 'GET', '/api/sync?after=1', a)).statusCode).toBe(410);
    expect((await req(ctx.app, 'GET', '/api/sync?after=2', a)).statusCode).toBe(200);
    const d = await as(ctx.app, 'd');
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
    expect((await req(ctx.app, 'GET', '/api/sync?after=2', d)).statusCode).toBe(401);
  });

  it('snapshot: 요청 시작 watermark·현재 상태 페이지·next_before_seq, 비참여 404·나간 사용자 404·비활성 401', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, b);
    const root = await send(ctx.app, a, general, { body: 'root' });
    await send(ctx.app, b, general, { body: 'reply', thread_root_id: root.id });
    const gone = await send(ctx.app, a, general, { body: '삭제될 본문', mention_user_ids: [ctx.ids.b] });
    await req(ctx.app, 'DELETE', `/api/messages/${gone.id}`, a);
    const last = await send(ctx.app, a, general, { body: 'last' });

    const page1 = (await req(ctx.app, 'GET', `/api/sync/snapshot?conversation_id=${general}&limit=2`, b)).json<{
      snapshot_cursor: number; messages: { seq: number; body: string | null; mention_user_ids: string[] }[]; has_more: boolean; next_before_seq: number | null;
    }>();
    expect(page1.snapshot_cursor).toBe(5);
    expect(page1.messages.map((m) => m.seq)).toEqual([gone.seq, last.seq]);
    expect(page1.messages[0]).toMatchObject({ body: null, mention_user_ids: [] });
    expect(page1).toMatchObject({ has_more: true, next_before_seq: gone.seq });
    const page2 = (await req(ctx.app, 'GET', `/api/sync/snapshot?conversation_id=${general}&limit=2&before_seq=${gone.seq}`, b)).json<{
      messages: { seq: number }[]; has_more: boolean; next_before_seq: number | null;
    }>();
    expect(page2.messages.map((m) => m.seq)).toEqual([root.seq, root.seq + 1]);
    expect(page2).toMatchObject({ has_more: false, next_before_seq: null });

    const c = await as(ctx.app, 'c');
    const l = await as(ctx.app, 'l');
    const d = await as(ctx.app, 'd');
    for (const who of [l, d]) await req(ctx.app, 'POST', `/api/conversations/${general}/join`, who);
    await req(ctx.app, 'DELETE', `/api/conversations/${general}/membership`, l);
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
    const url = `/api/sync/snapshot?conversation_id=${general}`;
    const cRes = await req(ctx.app, 'GET', url, c);
    expect(cRes.statusCode).toBe(404);
    expect(cRes.body).not.toContain('root');
    expect((await req(ctx.app, 'GET', url, l)).statusCode).toBe(404);
    expect((await req(ctx.app, 'GET', url, d)).statusCode).toBe(401);
    expect((await req(ctx.app, 'GET', '/api/sync/snapshot', b)).statusCode).toBe(400);
    expect((await req(ctx.app, 'GET', `${url}&limit=101`, b)).statusCode).toBe(400);
    // 비참여자의 전역 sync에도 이 대화 변경은 0건.
    expect((await syncPage(ctx.app, c, 'after=0')).changes).toHaveLength(0);
  });
});
