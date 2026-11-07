import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageView } from '../apps/server/src/shared.js';
import { as, openDm, req } from '../apps/server/test/conversations/conv-int-harness.js';
import { send } from '../apps/server/test/messages/msg-int-harness.js';
import { foldedRows, http, setupE2e, teardownE2e, truth, type E2eContext } from './support/harness.js';
import { ResumeClient } from './support/resume-client.js';

let ctx: E2eContext | undefined;
beforeEach(async () => {
  ctx = await setupE2e();
});
afterEach(async () => {
  await teardownE2e(ctx);
});

describe('전경 복귀', () => {
  it('FR-SYNC-07 전경 복귀 시 유효 세션 확인·재연결·커서 catch-up 후 100건과 수정·삭제·다른 기기 읽음을 반영하고 완료 전과 서버 불가 시에는 최신으로 표시하지 않는다', async () => {
    if (ctx === undefined) throw new Error('ctx 없음');
    const devA = await as(ctx.app, 'a');
    const devB = await as(ctx.app, 'a');
    const peer = await as(ctx.app, 'b');
    const dm = (await openDm(ctx.app, devA, ctx.ids.b)).json<{ id: string }>().id;
    const client = new ResumeClient(ctx, devB, [dm]);
    try {
      expect(await client.resume()).toBe(true);
      await client.background();
      expect(client.fresh).toBe(false);

      // 백그라운드 중: 상대가 100건, 수정 1·삭제 1, 기기 A가 50번째까지 읽음.
      const sent: MessageView[] = [];
      for (let i = 0; i < 100; i += 1) sent.push(await send(ctx.app, peer, dm, { body: `m-${i}` }));
      const edited = sent[59] as MessageView;
      const deleted = sent[9] as MessageView;
      expect((await req(ctx.app, 'PATCH', `/api/messages/${edited.id}`, peer, { body: 'm-59-수정' })).statusCode).toBe(200);
      expect((await req(ctx.app, 'DELETE', `/api/messages/${deleted.id}`, peer)).statusCode).toBeLessThan(300);
      const readSeq = (sent[49] as MessageView).seq;
      await http(ctx, 'PUT', '/api/read-state', devA, { conversation_id: dm, last_read_seq: readSeq });

      // 복귀: 완료 전에는 최신 아님.
      const pending = client.resume();
      expect(client.fresh).toBe(false);
      expect(await pending).toBe(true);
      expect(client.fresh).toBe(true);
      const rows = foldedRows(client.state, [dm]);
      expect(rows).toEqual(await truth(ctx, [dm]));
      expect(rows).toHaveLength(100);
      expect(rows.find((r) => r.id === edited.id)?.body).toBe('m-59-수정');
      expect(rows.find((r) => r.id === deleted.id)).toMatchObject({ deleted: true, body: null });
      const summary = client.summaries.find((c) => c.id === dm);
      expect(summary?.last_read_seq).toBe(readSeq);
      expect(summary?.unread_count).toBe(50);

      // catch-up과 구독 사이에 온 변경은 구독 replay로 받아 상태에 반영한다(Codex r1 P2).
      await client.background();
      let gap: MessageView | undefined;
      const app = ctx.app;
      expect(
        await client.resume(async () => {
          gap = await send(app, peer, dm, { body: 'gap-between-catchup-and-subscribe' });
        }),
      ).toBe(true);
      expect(foldedRows(client.state, [dm])).toEqual(await truth(ctx, [dm]));
      expect(foldedRows(client.state, [dm]).find((r) => r.id === gap?.id)?.body).toBe('gap-between-catchup-and-subscribe');

      // 서버 불가: 복귀 실패, 최신으로 표시하지 않는다.
      await client.background();
      await client.close();
      await ctx.app.close();
      expect(await client.resume()).toBe(false);
      expect(client.fresh).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);
});
