import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from './conv-int-harness.js';
import { send } from '../messages/msg-int-harness.js';
import { setupWsInt, subscribe } from '../realtime/ws-int-harness.js';

/** FR-CONV-02의 HTTP·DB 부분(지정 `it`은 WS 구독 5초 검증이 붙는 W-09에서 완성). */
let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

async function readState(cid: string, uid: string): Promise<unknown> {
  const res = await ctx.schema.pool.query(
    `SELECT m.joined_seq::int AS joined_seq, m.left_at IS NULL AS active, r.last_read_seq::int AS last_read_seq
       FROM conversation_members m LEFT JOIN conversation_read_state r ON r.conversation_id = m.conversation_id AND r.user_id = m.user_id
      WHERE m.conversation_id = $1 AND m.user_id = $2`,
    [cid, uid],
  );
  return res.rows[0];
}

describe('채널 참여·나가기', () => {
  it('참여 후 멤버 목록에 접근하고, 나가면 거부되며 discover에 다시 보이고 재참여할 수 있다', async () => {
    const owner = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const cid = await createChannel(ctx.app, owner, 'general');
    expect((await req(ctx.app, 'GET', `/api/conversations/${cid}/members`, b)).statusCode).toBe(404);
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, b)).json()).toEqual({ id: cid });
    // 이미 참여한 사용자의 join은 멱등.
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
    const members = (await req(ctx.app, 'GET', `/api/conversations/${cid}/members`, b)).json<{ members: { id: string }[] }>();
    expect(members.members.map((m) => m.id).sort()).toEqual([ctx.ids.a, ctx.ids.b].sort());
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}/membership`, b)).statusCode).toBe(204);
    expect(ctx.ended).toEqual([[cid, ctx.ids.b]]);
    // 나간 뒤: 이력(멤버 목록)·나가기 재요청 404, 목록 0건, discover에는 다시 보인다.
    expect((await req(ctx.app, 'GET', `/api/conversations/${cid}/members`, b)).statusCode).toBe(404);
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}/membership`, b)).statusCode).toBe(404);
    expect((await req(ctx.app, 'GET', '/api/conversations', b)).json().conversations).toEqual([]);
    expect((await req(ctx.app, 'GET', '/api/conversations/discover', b)).json().channels).toEqual([{ id: cid, name: 'general' }]);
    expect(ctx.ended).toHaveLength(1);
  });

  it('재참여 시 joined_seq와 read cursor를 last_seq로 초기화해 이전 메시지가 새 unread가 되지 않는다', async () => {
    const owner = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const cid = await createChannel(ctx.app, owner, 'random');
    await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, b);
    expect(await readState(cid, ctx.ids.b)).toEqual({ joined_seq: 0, active: true, last_read_seq: 0 });
    await req(ctx.app, 'DELETE', `/api/conversations/${cid}/membership`, b);
    // 나가 있는 동안 메시지가 쌓였다고 가정(W-08 전이라 last_seq만 올린다).
    await ctx.schema.pool.query('UPDATE conversations SET last_seq = 7 WHERE id = $1', [cid]);
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
    expect(await readState(cid, ctx.ids.b)).toEqual({ joined_seq: 7, active: true, last_read_seq: 7 });
    const list = (await req(ctx.app, 'GET', '/api/conversations', b)).json<{ conversations: unknown[] }>();
    expect(list.conversations).toEqual([expect.objectContaining({ id: cid, last_seq: 7, last_read_seq: 7, unread_count: 0 })]);
  });

  it('DM 참여는 404, DM 나가기는 400이다', async () => {
    const a = await as(ctx.app, 'a');
    const c = await as(ctx.app, 'c');
    const dm = (await req(ctx.app, 'POST', '/api/dms', a, { user_id: ctx.ids.b })).json<{ id: string }>().id;
    expect((await req(ctx.app, 'POST', `/api/conversations/${dm}/join`, c)).statusCode).toBe(404);
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${dm}/membership`, a)).statusCode).toBe(400);
  });
});

describe('FR-CONV-02 지정', () => {
  it('FR-CONV-02 참여 후 이력·구독이 가능하고 나가면 이력·쓰기·구독이 거부되며 5초 안에 기존 구독이 끊기고 목록에 남아 재참여할 수 있다', async () => {
    const ws = await setupWsInt();
    try {
      const { app } = ws.conv;
      const owner = await as(app, 'a');
      const b = await as(app, 'b');
      const cid = await createChannel(app, owner, 'general');
      expect((await req(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
      expect((await req(app, 'GET', `/api/conversations/${cid}/messages`, b)).statusCode).toBe(200);
      const wsB = await ws.open(b.token);
      expect(await subscribe(wsB, cid)).toMatchObject({ type: 'conversation.subscribed' });
      await send(app, owner, cid, { body: 'hello' });
      await wsB.waitFor((f) => f.type === 'message.created');

      const startedAt = performance.now();
      expect((await req(app, 'DELETE', `/api/conversations/${cid}/membership`, b)).statusCode).toBe(204);
      await wsB.waitFor((f) => f.type === 'error' && f.conversation_id === cid, 5000);
      expect(performance.now() - startedAt).toBeLessThanOrEqual(5000);
      // 끊긴 뒤 새 메시지는 0건, 이력·쓰기·재구독은 거부.
      const seen = wsB.frames.length;
      await send(app, owner, cid, { body: 'after leave' });
      expect((await req(app, 'GET', `/api/conversations/${cid}/messages`, b)).statusCode).toBe(404);
      expect((await req(app, 'POST', `/api/conversations/${cid}/messages`, b, { body: 'x', client_message_id: crypto.randomUUID() })).statusCode).toBe(404);
      expect(await subscribe(wsB, cid)).toMatchObject({ type: 'error', code: 'not_found' });
      expect(wsB.frames.slice(seen).filter((f) => f.type.startsWith('message.'))).toEqual([]);
      // discover 목록에 남아 재참여 → 다시 구독 가능.
      expect((await req(app, 'GET', '/api/conversations/discover', b)).json().channels).toEqual([{ id: cid, name: 'general' }]);
      expect((await req(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
      expect(await subscribe(wsB, cid, 0)).toMatchObject({ type: 'conversation.subscribed' });
    } finally {
      await ws.teardown();
    }
  });
});
