import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, convState, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from './conv-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

describe('채널 생성·discover', () => {
  it('FR-CONV-01 관리자만 공개 채널을 만들고 정규화 후 같은 이름은 거부되며 활성 멤버만 공개 채널 목록을 본다', async () => {
    const owner = await as(ctx.app, 'a');
    const member = await as(ctx.app, 'b');
    const disabled = await as(ctx.app, 'd');
    const id = await createChannel(ctx.app, owner, '  Café Général ');
    const before = await convState(ctx.schema);
    expect((await req(ctx.app, 'POST', '/api/conversations', member, { kind: 'channel', name: 'other' })).statusCode).toBe(403);
    // trim·NFC(NFD 입력)·case-fold 후 같은 이름은 409, 상태 변화 없음.
    for (const dup of ['café général', 'CAFÉ GÉNÉRAL  ', 'Café Général']) {
      const res = await req(ctx.app, 'POST', '/api/conversations', owner, { kind: 'channel', name: dup });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('name_taken');
    }
    expect((await req(ctx.app, 'POST', '/api/conversations', owner, { kind: 'channel', name: '   ' })).statusCode).toBe(400);
    expect(await convState(ctx.schema)).toEqual(before);
    const stored = await ctx.schema.pool.query('SELECT name, name_norm FROM conversations WHERE id = $1', [id]);
    expect(stored.rows[0]).toEqual({ name: 'Café Général', name_norm: 'café général' });
    // 활성 멤버는 discover로 공개 채널을 본다(메시지·멤버 정보 없음).
    const listed = await req(ctx.app, 'GET', '/api/conversations/discover', member);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ channels: [{ id, name: 'Café Général' }], next_cursor: null });
    // 비활성 계정·미인증은 401.
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
    expect((await req(ctx.app, 'GET', '/api/conversations/discover', disabled)).statusCode).toBe(401);
    expect((await req(ctx.app, 'GET', '/api/conversations/discover')).statusCode).toBe(401);
    // 생성자는 자동 참여: 목록에 있고 discover에는 없다.
    const ownerList = (await req(ctx.app, 'GET', '/api/conversations', owner)).json<{ conversations: { id: string }[] }>();
    expect(ownerList.conversations.map((c) => c.id)).toEqual([id]);
    expect((await req(ctx.app, 'GET', '/api/conversations/discover', owner)).json().channels).toEqual([]);
  });

  it('discover는 cursor paging을 하고 limit 범위 밖은 400이다', async () => {
    const owner = await as(ctx.app, 'a');
    const member = await as(ctx.app, 'b');
    const ids = [];
    for (const name of ['one', 'two', 'three']) ids.push(await createChannel(ctx.app, owner, name));
    ids.sort();
    const first = (await req(ctx.app, 'GET', '/api/conversations/discover?limit=2', member)).json<{ channels: { id: string }[]; next_cursor: string }>();
    expect(first.channels.map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect(first.next_cursor).toBe(ids[1]);
    const second = (await req(ctx.app, 'GET', `/api/conversations/discover?limit=2&after=${first.next_cursor}`, member)).json();
    expect(second).toEqual({ channels: [expect.objectContaining({ id: ids[2] })], next_cursor: null });
    expect((await req(ctx.app, 'GET', '/api/conversations/discover?limit=101', member)).statusCode).toBe(400);
    expect((await req(ctx.app, 'GET', '/api/conversations/discover?limit=0', member)).statusCode).toBe(400);
  });
});
