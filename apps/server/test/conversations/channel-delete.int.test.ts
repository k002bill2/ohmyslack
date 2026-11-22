import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { download, png, uploadedId } from '../attachments/att-harness.js';
import { send } from '../messages/msg-int-harness.js';
import { setupWsInt, subscribe } from '../realtime/ws-int-harness.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from './conv-int-harness.js';

/** FR-CONV-06 채널 삭제(소프트 삭제): 권한·삭제 후 접근·이름 재사용·실시간 정리. */
let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

async function convRow(cid: string): Promise<unknown> {
  const res = await ctx.schema.pool.query('SELECT deleted_at IS NOT NULL AS deleted, deleted_by FROM conversations WHERE id = $1', [cid]);
  return res.rows[0];
}

describe('FR-CONV-06 채널 삭제 권한', () => {
  it('FR-CONV-06 채널 삭제 권한 일반 멤버 403(DB 변화 0), 비멤버 404, DM 400, 없는 ID 404, owner 비멤버도 204, 두 번째 삭제 404', async () => {
    const owner = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const c = await as(ctx.app, 'c');
    const cid = await createChannel(ctx.app, owner, 'general');
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
    const del = await req(ctx.app, 'DELETE', `/api/conversations/${cid}`, b);
    expect(del.statusCode).toBe(403);
    expect(del.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await convRow(cid)).toEqual({ deleted: false, deleted_by: null });
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}`, c)).statusCode).toBe(404);
    const dm = (await req(ctx.app, 'POST', '/api/dms', owner, { user_id: ctx.ids.b })).json<{ id: string }>().id;
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${dm}`, owner)).statusCode).toBe(400);
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${crypto.randomUUID()}`, owner)).statusCode).toBe(404);
    expect((await req(ctx.app, 'DELETE', '/api/conversations/not-a-uuid', owner)).statusCode).toBe(404);
    // owner가 나간 채널도 지울 수 있다(멤버 여부 무관).
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}/membership`, owner)).statusCode).toBe(204);
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);
    expect(await convRow(cid)).toEqual({ deleted: true, deleted_by: ctx.ids.a });
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(404);
  });
});

describe('FR-CONV-06 삭제 후 접근', () => {
  it('목록·discover·이력·전송·join·멤버목록·첨부 다운로드가 404이고 같은 이름 채널을 새로 만들 수 있다', async () => {
    const owner = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const c = await as(ctx.app, 'c');
    const cid = await createChannel(ctx.app, owner, 'general');
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
    const msg = await send(ctx.app, b, cid, { body: 'hello' });
    const att = await uploadedId(ctx.app, b, cid, png(), 'image/png');
    expect((await download(ctx.app, b, att)).statusCode).toBe(200);

    expect((await req(ctx.app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);

    const listed = (await req(ctx.app, 'GET', '/api/conversations', b)).json<{ conversations: { id: string }[] }>();
    expect(listed.conversations.map((x) => x.id)).not.toContain(cid);
    expect((await req(ctx.app, 'GET', '/api/conversations/discover', c)).json().channels).toEqual([]);
    expect((await req(ctx.app, 'GET', `/api/conversations/${cid}/messages`, b)).statusCode).toBe(404);
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/messages`, b, { body: 'x', client_message_id: crypto.randomUUID() })).statusCode).toBe(404);
    expect((await req(ctx.app, 'PATCH', `/api/messages/${msg.id}`, b, { body: 'edited' })).statusCode).toBe(404);
    expect((await req(ctx.app, 'POST', `/api/conversations/${cid}/join`, c)).statusCode).toBe(404);
    expect((await req(ctx.app, 'GET', `/api/conversations/${cid}/members`, b)).statusCode).toBe(404);
    expect((await download(ctx.app, b, att)).statusCode).toBe(404);
    // 소프트 삭제: 메시지·멤버 행은 남는다.
    const kept = await ctx.schema.pool.query('SELECT (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS m, (SELECT count(*)::int FROM conversation_members WHERE conversation_id = $1) AS mem', [cid]);
    expect(kept.rows[0]).toEqual({ m: 1, mem: 2 });

    expect((await req(ctx.app, 'POST', '/api/conversations', owner, { kind: 'channel', name: 'General' })).statusCode).toBe(201);
  });
});

describe('FR-CONV-06 실시간', () => {
  it('삭제 뒤 멤버의 기존 구독이 5초 안에 끊기고 그 사용자의 모든 연결이 conversation.deleted를 받는다', async () => {
    const ws = await setupWsInt();
    try {
      const { app } = ws.conv;
      const owner = await as(app, 'a');
      const b = await as(app, 'b');
      const b2 = await as(app, 'b');
      const cid = await createChannel(app, owner, 'general');
      expect((await req(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
      const wsB = await ws.open(b.token);
      const wsB2 = await ws.open(b2.token);
      expect(await subscribe(wsB, cid)).toMatchObject({ type: 'conversation.subscribed' });

      const startedAt = performance.now();
      expect((await req(app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);
      await wsB.waitFor((f) => f.type === 'error' && f.conversation_id === cid, 5000);
      await wsB.waitFor((f) => f.type === 'conversation.deleted' && f.conversation_id === cid, 5000);
      await wsB2.waitFor((f) => f.type === 'conversation.deleted' && f.conversation_id === cid, 5000);
      expect(performance.now() - startedAt).toBeLessThanOrEqual(5000);
      expect(await subscribe(wsB, cid)).toMatchObject({ type: 'error', code: 'not_found' });
    } finally {
      await ws.teardown();
    }
  });
});
