import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { history, send } from './msg-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

async function mentionRows(messageId: string): Promise<string[]> {
  const res = await ctx.schema.pool.query<{ user_id: string }>('SELECT user_id FROM message_mentions WHERE message_id = $1 ORDER BY user_id', [messageId]);
  return res.rows.map((r) => r.user_id);
}

async function targets(rootId: string): Promise<string[]> {
  const res = await ctx.schema.pool.query<{ user_id: string }>('SELECT user_id FROM thread_unread_targets WHERE root_message_id = $1 ORDER BY user_id', [rootId]);
  return res.rows.map((r) => r.user_id);
}

describe('멘션', () => {
  // 지정 테스트(FR-MSG-07) 보류: "이미 읽은 메시지는 새 미읽음이 되지 않으며 읽음으로 해제된다"는 W-09 `PUT /api/read-state`와
  // `GET /api/conversations` mention_count 집계가 있어야 단언할 수 있다(REPORT "W-09 완성"). todo 선언은 fr-coverage가 실패로
  // 처리하므로 지정 이름 선언은 W-09가 추가한다. 저장 규칙은 아래 보조 테스트가 검증한다.

  it('mention 저장 규칙: 활성 참여자만 1회·자기 제외, 수정 시 추가·제거, 삭제 시 행 제거, 스레드 대상 자격은 유지', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const l = await as(ctx.app, 'l');
    const general = await createChannel(ctx.app, a, 'general');
    for (const who of [b, l]) await req(ctx.app, 'POST', `/api/conversations/${general}/join`, who);
    // C는 비참여자, 무작위 UUID는 없는 사용자, A는 자기 자신, B는 중복.
    const requested = [ctx.ids.b, ctx.ids.b, ctx.ids.a, ctx.ids.c, randomUUID()];
    const root = await send(ctx.app, a, general, { body: '@b 확인', mention_user_ids: requested });
    expect(root.mention_user_ids).toEqual([ctx.ids.b]);
    expect(await mentionRows(root.id)).toEqual([ctx.ids.b]);
    // 원문 작성자 A와 mention 받은 B가 스레드 대상.
    expect(await targets(root.id)).toEqual(sorted([ctx.ids.a, ctx.ids.b]));

    // 수정: B 제거, L 추가. 응답·이력·DB가 같다.
    const edited = await req(ctx.app, 'PATCH', `/api/messages/${root.id}`, a, { body: '@l 확인', mention_user_ids: [ctx.ids.l, ctx.ids.a] });
    expect(edited.json<{ mention_user_ids: string[] }>().mention_user_ids).toEqual([ctx.ids.l]);
    expect(await mentionRows(root.id)).toEqual([ctx.ids.l]);
    expect((await history(ctx.app, b, general)).messages[0]?.mention_user_ids).toEqual([ctx.ids.l]);
    // 자격은 편집 뒤에도 유지(B 유지, L 추가).
    expect(await targets(root.id)).toEqual(sorted([ctx.ids.a, ctx.ids.b, ctx.ids.l]));

    // 답글 작성자도 대상이 되고, 답글 mention은 원문 스레드 대상으로 기록된다.
    const reply = await send(ctx.app, l, general, { body: '답', thread_root_id: root.id, mention_user_ids: [ctx.ids.a] });
    expect(reply.mention_user_ids).toEqual([ctx.ids.a]);

    // 나간 사용자는 이후 mention 대상이 아니다.
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${general}/membership`, l)).statusCode).toBe(204);
    const later = await send(ctx.app, a, general, { body: '@l', mention_user_ids: [ctx.ids.l] });
    expect(later.mention_user_ids).toEqual([]);

    // 삭제: mention 행 제거, 대상 자격은 유지.
    expect((await req(ctx.app, 'DELETE', `/api/messages/${reply.id}`, l)).statusCode).toBe(404); // 나간 사용자는 404
    expect((await req(ctx.app, 'DELETE', `/api/messages/${root.id}`, a)).statusCode).toBe(200);
    expect(await mentionRows(root.id)).toEqual([]);
    expect(await targets(root.id)).toEqual(sorted([ctx.ids.a, ctx.ids.b, ctx.ids.l]));
  });
});

describe('멘션 집계(W-09a)', () => {
  it('FR-MSG-07 멘션은 mention_user_ids의 참여자만 1회 집계되고 자기 멘션은 제외되며 수정 시 추가·제거되고 이미 읽은 메시지는 새 미읽음이 되지 않으며 읽음으로 해제된다', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    await req(ctx.app, 'POST', `/api/conversations/${general}/join`, b);
    const counts = async (who: typeof a): Promise<{ mention_count: number; unread_count: number }> => {
      const list = (await req(ctx.app, 'GET', '/api/conversations', who)).json<{ conversations: { id: string; mention_count: number; unread_count: number }[] }>();
      const found = list.conversations.find((c) => c.id === general);
      return { mention_count: found?.mention_count ?? -1, unread_count: found?.unread_count ?? -1 };
    };
    const read = (who: typeof a, seq: number) =>
      req(ctx.app, 'PUT', '/api/read-state', who, { conversation_id: general, last_read_seq: seq });

    // 참여자 B만 1회(중복·자기·비참여자·없는 사용자 제외).
    const m1 = await send(ctx.app, a, general, { body: '@B @B @A @C', mention_user_ids: [ctx.ids.b, ctx.ids.b, ctx.ids.a, ctx.ids.c, randomUUID()] });
    expect(await counts(b)).toEqual({ mention_count: 1, unread_count: 1 });
    expect((await counts(a)).mention_count).toBe(0);

    // 수정 시 제거·추가.
    expect((await req(ctx.app, 'PATCH', `/api/messages/${m1.id}`, a, { body: '없음', mention_user_ids: [] })).statusCode).toBe(200);
    expect((await counts(b)).mention_count).toBe(0);
    expect((await req(ctx.app, 'PATCH', `/api/messages/${m1.id}`, a, { body: '@B', mention_user_ids: [ctx.ids.b] })).statusCode).toBe(200);
    expect((await counts(b)).mention_count).toBe(1);

    // 읽음으로 해제.
    expect((await read(b, m1.seq)).statusCode).toBe(200);
    expect(await counts(b)).toEqual({ mention_count: 0, unread_count: 0 });

    // 이미 읽은 메시지에 나중에 멘션이 추가돼도 새 미읽음이 되지 않는다(cursor 후퇴 없음).
    const m2 = await send(ctx.app, a, general, { body: '그냥' });
    expect((await read(b, m2.seq)).statusCode).toBe(200);
    expect((await req(ctx.app, 'PATCH', `/api/messages/${m2.id}`, a, { body: '@B 추가', mention_user_ids: [ctx.ids.b] })).statusCode).toBe(200);
    expect(await counts(b)).toEqual({ mention_count: 0, unread_count: 0 });
    expect(await mentionRows(m2.id)).toEqual([ctx.ids.b]);
  });
});
