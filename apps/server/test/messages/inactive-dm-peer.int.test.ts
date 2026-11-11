import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, openDm, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { history, replies, send, sendRaw } from './msg-int-harness.js';

/**
 * 비활성 상대 DM 전송 거부: 상대가 받을 수 없는(로그인·push 불가) 이미 열린 DM에는 루트·답글 모두 403 forbidden.
 * DB 변화·이벤트 0건. 채널·활성 DM·읽기·편집·삭제는 그대로.
 */
let ctx: ConvIntContext;
let events: { name: string }[];

beforeEach(async () => {
  ctx = await setupConvInt();
  events = [];
  for (const name of ['created', 'updated', 'deleted'] as const) ctx.app.messageEvents.on(name, () => events.push({ name }));
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

const disable = (id: string) => ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [id]);
const counts = async () => {
  const res = await ctx.schema.pool.query<{ m: number; c: number; seq: string }>(
    `SELECT (SELECT count(*)::int FROM messages) AS m, (SELECT count(*)::int FROM conversation_changes) AS c,
            (SELECT COALESCE(sum(last_seq), 0)::text FROM conversations) AS seq`,
  );
  return res.rows[0];
};

describe('비활성 상대 DM 전송', () => {
  it('상대가 비활성이면 루트·답글 전송은 403 forbidden이고 DB·이벤트 변화가 없다', async () => {
    const a = await as(ctx.app, 'a');
    const dm = (await openDm(ctx.app, a, ctx.ids.b)).json<{ id: string }>().id;
    const root = await send(ctx.app, a, dm, { body: 'before' });
    await disable(ctx.ids.b);
    const before = await counts();
    events.length = 0;

    const rootRes = await sendRaw(ctx.app, a, dm, { body: 'after' });
    expect(rootRes.statusCode).toBe(403);
    expect(rootRes.json().error.code).toBe('forbidden');
    const replyRes = await sendRaw(ctx.app, a, dm, { body: 'reply', thread_root_id: root.id });
    expect(replyRes.statusCode).toBe(403);
    expect(replyRes.json().error.code).toBe('forbidden');

    expect(await counts()).toEqual(before);
    expect(events).toEqual([]);
  });

  it('읽기·답글 조회·편집·삭제는 상대 비활성 뒤에도 그대로 동작한다', async () => {
    const a = await as(ctx.app, 'a');
    const dm = (await openDm(ctx.app, a, ctx.ids.b)).json<{ id: string }>().id;
    const root = await send(ctx.app, a, dm, { body: 'before' });
    await disable(ctx.ids.b);

    expect((await history(ctx.app, a, dm)).messages.map((m) => m.id)).toEqual([root.id]);
    expect((await replies(ctx.app, a, root.id)).root.id).toBe(root.id);
    expect((await req(ctx.app, 'PATCH', `/api/messages/${root.id}`, a, { body: 'edited' })).statusCode).toBe(200);
    expect((await req(ctx.app, 'DELETE', `/api/messages/${root.id}`, a)).statusCode).toBe(200);
  });

  it('활성 상대 DM과 채널(비활성 멤버 포함)은 201을 유지한다', async () => {
    const a = await as(ctx.app, 'a');
    const dm = (await openDm(ctx.app, a, ctx.ids.b)).json<{ id: string }>().id;
    const channel = await createChannel(ctx.app, a, 'with-inactive');
    const c = await as(ctx.app, 'c');
    expect((await req(ctx.app, 'POST', `/api/conversations/${channel}/join`, c)).statusCode).toBe(200);
    await disable(ctx.ids.c);

    expect((await sendRaw(ctx.app, a, dm, { body: 'dm' })).statusCode).toBe(201);
    expect((await sendRaw(ctx.app, a, channel, { body: 'ch' })).statusCode).toBe(201);
  });

  it('비활성 전에 만든 메시지의 같은 멱등 키 재시도는 원결과를 돌려준다', async () => {
    const a = await as(ctx.app, 'a');
    const dm = (await openDm(ctx.app, a, ctx.ids.b)).json<{ id: string }>().id;
    const body = { client_message_id: '11111111-1111-4111-8111-111111111111', body: 'once' };
    const first = await sendRaw(ctx.app, a, dm, body);
    expect(first.statusCode).toBe(201);
    await disable(ctx.ids.b);
    const retry = await sendRaw(ctx.app, a, dm, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().message.id).toBe(first.json().message.id);
  });

  it('봇 owner DM에서 봇이 비활성이면 owner 전송도 403이다', async () => {
    const a = await as(ctx.app, 'a');
    const dm = (await openDm(ctx.app, a, ctx.ids.c)).json<{ id: string }>().id;
    // CLI 봇 비활성화와 같은 상태(dm.int.test W-22b와 같은 준비).
    await ctx.schema.pool.query("UPDATE users SET kind = 'bot', password_hash = NULL, status = 'disabled' WHERE id = $1", [ctx.ids.c]);
    const res = await sendRaw(ctx.app, a, dm, { body: 'to bot' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });
});
