import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, openDm, req, setupConvInt, teardownConvInt, type ConvIntContext } from './conv-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

describe('DM 시작', () => {
  it('FR-CONV-03 같은 멤버 쌍의 DM 시작은 순서·동시 요청과 무관하게 같은 DM ID를 반환한다', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    // 순서: A→B와 B→A가 같은 ID(정렬된 pair key).
    const ab = await openDm(ctx.app, a, ctx.ids.b);
    expect(ab.statusCode).toBe(200);
    const id = ab.json<{ id: string }>().id;
    expect((await openDm(ctx.app, b, ctx.ids.a)).json().id).toBe(id);
    // 동시: 처음 생성되는 다른 쌍(A·C)에 순서를 섞은 10건.
    const c = await as(ctx.app, 'c');
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? openDm(ctx.app, a, ctx.ids.c) : openDm(ctx.app, c, ctx.ids.a))),
    );
    expect(burst.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
    const acIds = new Set(burst.map((r) => r.json<{ id: string }>().id));
    expect(acIds.size).toBe(1);
    const rows = await ctx.schema.pool.query("SELECT id FROM conversations WHERE kind = 'dm' ORDER BY id");
    expect(rows.rowCount).toBe(2);
    const [acId] = [...acIds];
    const members = await ctx.schema.pool.query(
      'SELECT user_id, joined_seq::int AS joined_seq, left_at FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id',
      [acId],
    );
    expect(members.rows).toEqual([ctx.ids.a, ctx.ids.c].sort().map((u) => ({ user_id: u, joined_seq: 0, left_at: null })));
    const reads = await ctx.schema.pool.query('SELECT count(*)::int AS n FROM conversation_read_state WHERE conversation_id = $1', [acId]);
    expect(reads.rows[0].n).toBe(2);
  });

  it('자기 자신·비활성·없는 사용자와의 DM은 400 invalid_request이고 행을 만들지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
    for (const target of [ctx.ids.a, ctx.ids.d, '00000000-0000-4000-8000-000000000000']) {
      const res = await openDm(ctx.app, a, target);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect((await ctx.schema.pool.query('SELECT 1 FROM conversations')).rowCount).toBe(0);
  });

  it('DM은 두 참여자의 목록에 상대 ID와 함께 보이고 제3자 목록에는 없다', async () => {
    const a = await as(ctx.app, 'a');
    const id = (await openDm(ctx.app, a, ctx.ids.b)).json<{ id: string }>().id;
    const mine = (await req(ctx.app, 'GET', '/api/conversations', a)).json<{ conversations: { id: string; peer_user_id: string }[] }>();
    expect(mine.conversations).toEqual([expect.objectContaining({ id, kind: 'dm', peer_user_id: ctx.ids.b, unread_count: 0 })]);
    const c = await as(ctx.app, 'c');
    expect((await req(ctx.app, 'GET', '/api/conversations', c)).json().conversations).toEqual([]);
  });
});
