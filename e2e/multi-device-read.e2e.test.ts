import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../apps/server/src/shared.js';
import { as, openDm } from '../apps/server/test/conversations/conv-int-harness.js';
import { send } from '../apps/server/test/messages/msg-int-harness.js';
import { http, setupE2e, teardownE2e, type E2eContext } from './support/harness.js';
import { WsClient } from './support/ws-client.js';

let ctx: E2eContext | undefined;
beforeEach(async () => {
  ctx = await setupE2e();
});
afterEach(async () => {
  await teardownE2e(ctx);
});

describe('다중 기기 읽음 전파', () => {
  it('FR-SYNC-04 기기 A가 본문·스레드 읽음을 저장하면 같은 계정 기기 B에 2초 안에 read.updated가 도착하고 본문·스레드·멘션 수가 일치하며 스레드 수는 본문 수에 더해지지 않는다', async () => {
    if (ctx === undefined) throw new Error('ctx 없음');
    const devA = await as(ctx.app, 'a');
    const devB = await as(ctx.app, 'a');
    const peer = await as(ctx.app, 'b');
    const outsider = await as(ctx.app, 'c');
    const dm = (await openDm(ctx.app, devA, ctx.ids.b)).json<{ id: string }>().id;
    const r1 = await send(ctx.app, peer, dm, { body: 'r1' });
    await send(ctx.app, peer, dm, { body: 'r2' });
    await send(ctx.app, peer, dm, { body: 'r3 @a', mention_user_ids: [ctx.ids.a] });
    const p1 = await send(ctx.app, peer, dm, { body: 'p1', thread_root_id: r1.id });
    await send(ctx.app, peer, dm, { body: 'p2', thread_root_id: r1.id });
    await send(ctx.app, peer, dm, { body: 'p3 @a', thread_root_id: r1.id, mention_user_ids: [ctx.ids.a] });

    const wsB = await WsClient.open(ctx.wsUrl, devB);
    const wsC = await WsClient.open(ctx.wsUrl, outsider);
    try {
      const t0 = performance.now();
      await http(ctx, 'PUT', '/api/read-state', devA, { conversation_id: dm, last_read_seq: r1.seq });
      const main = await wsB.waitFor((f) => f.type === 'read.updated' && f.thread_root_id === null, 2000);
      const t1 = performance.now();
      await http(ctx, 'PUT', '/api/read-state', devA, { conversation_id: dm, last_read_seq: p1.seq, thread_root_id: r1.id });
      const thread = await wsB.waitFor((f) => f.type === 'read.updated' && f.thread_root_id === r1.id, 2000);
      expect(main.at - t0).toBeLessThan(2000);
      expect(thread.at - t1).toBeLessThan(2000);
      expect(main.frame).toMatchObject({ conversation_id: dm, last_read_seq: r1.seq });
      expect(thread.frame).toMatchObject({ conversation_id: dm, last_read_seq: p1.seq });

      const list = async (s: typeof devA): Promise<ConversationSummary | undefined> =>
        (await http<{ conversations: ConversationSummary[] }>(ctx as E2eContext, 'GET', '/api/conversations', s)).conversations.find((c) => c.id === dm);
      const sa = await list(devA);
      const sb = await list(devB);
      expect(sb).toEqual(sa);
      expect(sb?.last_read_seq).toBe(r1.seq);
      expect(sb?.unread_count).toBe(2); // r2, r3 — 스레드 미읽음 2건(p2, p3)은 더해지지 않는다
      expect(sb?.unread_thread_count).toBe(1);
      expect(sb?.unread_threads).toEqual([expect.objectContaining({ root_message_id: r1.id, last_read_seq: p1.seq, unread_reply_count: 2 })]);
      expect(sb?.mention_count).toBe(sa?.mention_count);

      // 비참여자 C(다른 계정)에게는 어떤 프레임도 가지 않는다.
      await new Promise((r) => setTimeout(r, 300));
      expect(wsC.frames()).toEqual([]);
    } finally {
      await wsB.close();
      await wsC.close();
    }
  }, 30_000);
});
