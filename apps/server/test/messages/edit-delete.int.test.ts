import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { history, replies, send } from './msg-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

const SECRET_BODY = '삭제될 비밀 본문';

describe('수정·삭제', () => {
  it('FR-MSG-05 본인만 수정·삭제하고 참여 비작성자는 403·비참여자는 404이며 삭제 본문·멘션은 이력·답글·sync·WS 어디에도 다시 나오지 않고 답글은 남는다', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const c = await as(ctx.app, 'c');
    const general = await createChannel(ctx.app, a, 'general');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, b);
    const events: unknown[] = [];
    for (const name of ['created', 'updated', 'deleted'] as const) ctx.app.messageEvents.on(name, (e) => events.push({ name, e }));
    const root = await send(ctx.app, a, general, { body: '원래 본문', mention_user_ids: [ctx.ids.b] });
    const reply = await send(ctx.app, b, general, { body: '살아 남을 답글', thread_root_id: root.id });

    // 참여 비작성자 403, 비참여자 404 — 둘 다 데이터 변화 0.
    for (const [who, status] of [[b, 403], [c, 404]] as const) {
      expect((await req(ctx.app, 'PATCH', `/api/messages/${root.id}`, who, { body: 'x' })).statusCode).toBe(status);
      expect((await req(ctx.app, 'DELETE', `/api/messages/${root.id}`, who)).statusCode).toBe(status);
    }
    expect((await history(ctx.app, a, general)).messages[0]?.body).toBe('원래 본문');

    // 본인 수정: 새 change_id, edited_at, mention 재계산.
    const edited = await req(ctx.app, 'PATCH', `/api/messages/${root.id}`, a, { body: SECRET_BODY, mention_user_ids: [ctx.ids.b] });
    expect(edited.statusCode).toBe(200);
    const editedJson = edited.json<{ change_id: number; message: { edited_at: string | null }; mention_user_ids: string[] }>();
    expect(editedJson.message.edited_at).not.toBeNull();
    expect(editedJson.mention_user_ids).toEqual([ctx.ids.b]);

    // 본인 삭제: tombstone, mention 행 제거, change(op=delete).
    const deleted = await req(ctx.app, 'DELETE', `/api/messages/${root.id}`, a);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<{ change_id: number }>().change_id).toBeGreaterThan(editedJson.change_id);
    expect(deleted.body).not.toContain(SECRET_BODY);
    const mentionRows = await ctx.schema.pool.query('SELECT 1 FROM message_mentions WHERE message_id = $1', [root.id]);
    expect(mentionRows.rowCount).toBe(0);
    const ops = await ctx.schema.pool.query<{ op: string }>('SELECT op FROM conversation_changes WHERE message_id = $1 ORDER BY change_id', [root.id]);
    expect(ops.rows.map((r) => r.op)).toEqual(['create', 'edit', 'delete']);

    // 이력·답글: 삭제 본문·mention 없음, 답글은 남는다.
    const page = await history(ctx.app, a, general);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ id: root.id, body: null, mention_user_ids: [] });
    const thread = await replies(ctx.app, b, root.id);
    expect(thread.root).toMatchObject({ body: null, mention_user_ids: [] });
    expect(thread.replies.map((r) => r.id)).toEqual([reply.id]);
    for (const text of [JSON.stringify(page), JSON.stringify(thread)]) expect(text).not.toContain(SECRET_BODY);

    // WS 원천(도메인 이벤트): deleted 이벤트는 본문·mention을 싣지 않는다.
    const deletedEvent = events.find((x) => (x as { name: string }).name === 'deleted');
    expect(JSON.stringify(deletedEvent)).not.toContain(SECRET_BODY);
    expect(Object.keys((deletedEvent as { e: object }).e).sort()).toEqual(['changeId', 'conversationId', 'deletedAt', 'messageId', 'seq']);

    // 삭제 후 수정·재삭제는 404(되살리기 없음).
    expect((await req(ctx.app, 'PATCH', `/api/messages/${root.id}`, a, { body: '부활' })).statusCode).toBe(404);
    expect((await req(ctx.app, 'DELETE', `/api/messages/${root.id}`, a)).statusCode).toBe(404);
    const row = await ctx.schema.pool.query<{ body: string | null }>('SELECT body FROM messages WHERE id = $1', [root.id]);
    expect(row.rows[0]?.body).toBeNull();
  });
});
