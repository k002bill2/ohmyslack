import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as } from '../apps/server/test/conversations/conv-int-harness.js';
import { botFetch, botSyncFrom, openBotWs, setupBotE2e, type BotE2e } from './support/bot-client.js';
import { foldedRows, foldMessage, setupE2e, teardownE2e, truth, type E2eContext, type FoldState } from './support/harness.js';
import { burst, foldWs, isMsgFrame, type MsgFrame } from './support/reconnect-scenario.js';

/**
 * 봇 catch-up(FR-BOT-05, TRD §5-2 6·7항). 단절 시간은 FR-SYNC-02와 같이 압축한다(DEV_DESIGN §5 게이트 표: PR 게이트는 압축 버전,
 * 실제 60초 단절은 `e2e:realgap` 경로). 시간이 아니라 "단절 중 생긴 변경"이 catch-up 대상이라 결과가 같다.
 */
let ctx: E2eContext | undefined;
let b: BotE2e | undefined;

beforeEach(async () => {
  ctx = await setupE2e();
  b = await setupBotE2e(ctx);
});

afterEach(async () => {
  await b?.app.close();
  await teardownE2e(ctx);
  b = undefined;
});

const msg = (body: string) => ({ client_message_id: randomUUID(), body });

describe('봇 따라잡기(압축 단절)', () => {
  it('FR-BOT-05 봇 연결 60초 단절 중 owner 메시지와 수정·삭제가 생겨도 봇 sync·WS 따라잡기에서 누락·중복이 0이고 rate limit 초과 전송·수정은 429로 저장되지 않는다', async () => {
    if (ctx === undefined || b === undefined) throw new Error('ctx 없음');
    const owner = await as(ctx.app, 'a');
    const dm = b.bot.dmConversationId;
    const convs = [dm];
    await burst(ctx, owner, convs, 6, 'seed');

    // 봇: 초기 sync로 기준 상태·커서 기록 → WS 연결 후 단절.
    const base = await botSyncFrom(b, 0);
    let state: FoldState = new Map();
    for (const c of base.changes) state = foldMessage(state, c.change_id, c.message);
    const cursor = base.through;
    const first = await openBotWs(b);
    await first.close();

    // 단절 중 owner 메시지 100건 + 수정·삭제.
    await burst(ctx, owner, convs, 100, 'gap');

    // 복귀: WS 구독 + REST catch-up을 owner의 동시 게시와 경합시킨다.
    const ws = await openBotWs(b);
    try {
      const racing = burst(ctx, owner, convs, 30, 'race');
      ws.subscribe(dm, cursor);
      const [catchup] = await Promise.all([
        botSyncFrom(b, cursor),
        ws.waitFor(() => ws.frames().some((f) => f.type === 'conversation.subscribed' && f.conversation_id === dm)),
      ]);
      await racing;
      const finalSync = await botSyncFrom(b, cursor);
      const maxId = Math.max(0, ...finalSync.changes.filter((x) => x.conversation_id === dm).map((x) => x.change_id));
      await ws.waitFor(() => ws.frames().some((f) => isMsgFrame(f) && f.change_id >= maxId), 15_000);

      const frames = ws.frames();
      const ack = frames.find((f) => f.type === 'conversation.subscribed');
      const through = ack?.type === 'conversation.subscribed' ? ack.through_cursor : -1;
      const ackIdx = frames.findIndex((f) => f.type === 'conversation.subscribed');
      const mine = frames.map((f, i) => ({ f, i })).filter((x): x is { f: MsgFrame; i: number } => isMsgFrame(x.f));
      for (const { f, i } of mine) {
        if (i < ackIdx) expect(f.change_id).toBeLessThanOrEqual(through);
        else expect(f.change_id).toBeGreaterThan(through);
        expect(f.change_id).toBeGreaterThan(cursor);
      }
      const ids = mine.map((x) => x.f.change_id);
      expect(new Set(ids).size).toBe(ids.length);

      for (const ch of catchup.changes) state = foldMessage(state, ch.change_id, ch.message);
      state = foldWs(state, frames);
      const expected = await truth(ctx, convs);
      const actual = foldedRows(state, convs);
      expect(expected.length).toBe(6 + 100 + 30);
      expect(new Set(actual.map((r) => r.id)).size).toBe(actual.length);
      expect(actual).toEqual(expected);
    } finally {
      await ws.close();
    }

    // rate limit(토큰별 분당 생성 30·수정 60): 초과는 429 + Retry-After, 저장 0.
    const countBot = async (): Promise<number> => {
      const r = await ctx?.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE author_id = $1', [b?.bot.botUserId]);
      return r?.rows[0]?.n ?? -1;
    };
    let lastId = '';
    for (let i = 0; i < 30; i += 1) {
      const res = await botFetch(b, 'POST', `conversations/${dm}/messages`, msg(`보고-${i}`));
      expect(res.status).toBe(201);
      lastId = res.json.message.id;
    }
    const over = await botFetch(b, 'POST', `conversations/${dm}/messages`, msg('초과'));
    expect(over.status).toBe(429);
    expect(await countBot()).toBe(30);
    for (let i = 0; i < 60; i += 1) expect((await botFetch(b, 'PATCH', `messages/${lastId}`, { body: `수정-${i}` })).status).toBe(200);
    const overEdit = await botFetch(b, 'PATCH', `messages/${lastId}`, { body: '초과 수정' });
    expect(overEdit.status).toBe(429);
    const body = await ctx.schema.pool.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [lastId]);
    expect(body.rows[0]?.body).toBe('수정-59');
  }, 90_000);
});
