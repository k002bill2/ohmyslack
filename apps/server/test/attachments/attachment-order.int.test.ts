import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  historyResponseSchema,
  messageWriteResponseSchema,
  repliesResponseSchema,
  syncResponseSchema,
  type WsServerFrame,
} from '../../src/shared.js';
import { bot, botUpload, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import type { Session } from '../auth/members-int-harness.js';
import type { TestSchema } from '../support/test-db.js';
import { setupWsInt, subscribe, type WsIntContext } from '../realtime/ws-int-harness.js';
import { png, uploadedId } from './att-harness.js';

/** 첨부 표시 순서 = 요청 `attachment_ids` 순서(정본: TRD R3.7 §3 messages 행·§6-1 결속, DEV_DESIGN W-31). */
let ws: WsIntContext | undefined;
let lc: BotListenerContext | undefined;

afterEach(async () => {
  await ws?.teardown();
  ws = undefined;
  await teardownBotListener(lc);
  lc = undefined;
});

type Created = Extract<WsServerFrame, { type: 'message.created' }>;
const idsOf = (m: { readonly attachments: readonly { readonly id: string }[] }): string[] => m.attachments.map((a) => a.id);

/** 업로드 순서대로 created_at을 1초씩 벌려 둔다(같은 ms 업로드가 ID 순으로 갈리는 우연을 없앤다). 결속 유예 1시간 안. */
async function spreadCreatedAt(schema: TestSchema, ids: readonly string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await schema.pool.query("UPDATE attachments SET created_at = now() - make_interval(secs => $2) WHERE id = $1", [id, 60 - i]);
  }
}

async function uploadMany(c: WsIntContext, who: Session, conversationId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await uploadedId(c.conv.app, who, conversationId, png(2 + i, 3), 'image/png'));
  await spreadCreatedAt(c.conv.schema, ids);
  return ids;
}

function send(c: WsIntContext, who: Session, conversationId: string, payload: Record<string, unknown>) {
  return req(c.conv.app, 'POST', `/api/conversations/${conversationId}/messages`, who, { client_message_id: randomUUID(), body: '첨부', ...payload });
}

describe('첨부 표시 순서(TRD R3.7)', () => {
  it('A·B·C를 올린 뒤 [C, A, B]로 보내면 전송 응답·이력·답글·sync·WS 모두 C, A, B다', async () => {
    ws = await setupWsInt();
    const c = ws;
    const a = await as(c.conv.app, 'a');
    const b = await as(c.conv.app, 'b');
    const channel = await createChannel(c.conv.app, a, 'order');
    await req(c.conv.app, 'POST', `/api/conversations/${channel}/join`, b);
    const client = await c.open(b.token);
    expect((await subscribe(client, channel)).type).toBe('conversation.subscribed');

    const [A, B, C] = await uploadMany(c, a, channel, 3);
    const rootRes = await send(c, a, channel, { body: '루트', attachment_ids: [C, A, B] });
    expect(rootRes.statusCode).toBe(201);
    const root = messageWriteResponseSchema.parse(rootRes.json()).message;
    expect(idsOf(root)).toEqual([C, A, B]);

    const [D, E, F] = await uploadMany(c, a, channel, 3);
    const replyRes = await send(c, a, channel, { body: '답글', thread_root_id: root.id, attachment_ids: [F, D, E] });
    expect(replyRes.statusCode).toBe(201);
    const reply = messageWriteResponseSchema.parse(replyRes.json()).message;
    expect(idsOf(reply)).toEqual([F, D, E]);

    const hist = historyResponseSchema.parse((await req(c.conv.app, 'GET', `/api/conversations/${channel}/messages`, b)).json());
    expect(idsOf(hist.messages.find((m) => m.id === root.id) ?? { attachments: [] })).toEqual([C, A, B]);

    const replies = repliesResponseSchema.parse((await req(c.conv.app, 'GET', `/api/messages/${root.id}/replies`, b)).json());
    expect(replies.replies.map(idsOf)).toEqual([[F, D, E]]);

    const sync = syncResponseSchema.parse((await req(c.conv.app, 'GET', '/api/sync?after=0&limit=500', b)).json());
    const synced = new Map(sync.changes.filter((ch) => ch.op === 'create').map((ch) => [ch.message.id, idsOf(ch.message)]));
    expect(synced.get(root.id)).toEqual([C, A, B]);
    expect(synced.get(reply.id)).toEqual([F, D, E]);

    await client.waitFor((f) => f.type === 'message.created' && f.message.id === reply.id);
    const created = new Map(
      client.frames.filter((f): f is Created => f.type === 'message.created').map((f) => [f.message.id, idsOf(f.message)]),
    );
    expect(created.get(root.id)).toEqual([C, A, B]);
    expect(created.get(reply.id)).toEqual([F, D, E]);
  });

  it('순서만 바꾼 같은 client_message_id 재시도는 원결과이고 순서는 첫 요청 것이다', async () => {
    ws = await setupWsInt();
    const c = ws;
    const a = await as(c.conv.app, 'a');
    const channel = await createChannel(c.conv.app, a, 'retry');
    const [A, B, C] = await uploadMany(c, a, channel, 3);
    const key = randomUUID();
    const first = await send(c, a, channel, { client_message_id: key, attachment_ids: [C, A, B] });
    expect(first.statusCode).toBe(201);
    const original = messageWriteResponseSchema.parse(first.json()).message;

    const again = await send(c, a, channel, { client_message_id: key, attachment_ids: [A, B, C] });
    expect(again.statusCode).toBe(200);
    const replayed = messageWriteResponseSchema.parse(again.json()).message;
    expect(replayed.id).toBe(original.id);
    expect(idsOf(replayed)).toEqual([C, A, B]);
  });

  it('같은 ID가 두 번 든 요청은 400 invalid_attachments이고 결속 0이다', async () => {
    ws = await setupWsInt();
    const c = ws;
    const a = await as(c.conv.app, 'a');
    const channel = await createChannel(c.conv.app, a, 'dup');
    const [A, B] = await uploadMany(c, a, channel, 2);
    const res = await send(c, a, channel, { attachment_ids: [B, A, B] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_attachments' } });
    const bound = await c.conv.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM attachments WHERE message_id IS NOT NULL');
    expect(bound.rows[0]?.n).toBe(0);
  });

  it('위치 기록이 없는(NULL) 기존 결속 행은 created_at, id 순서를 유지한다', async () => {
    ws = await setupWsInt();
    const c = ws;
    const a = await as(c.conv.app, 'a');
    const channel = await createChannel(c.conv.app, a, 'legacy');
    const [X, Y, Z] = await uploadMany(c, a, channel, 3);
    const sent = await send(c, a, channel, { body: '0007 이전 메시지' });
    expect(sent.statusCode).toBe(201);
    const messageId = messageWriteResponseSchema.parse(sent.json()).message.id;
    // 0007 이전 결속 상태를 직접 만든다: message_id만 채우고 위치 열은 건드리지 않는다(NULL).
    // created_at: Y·Z 같음(→ id 순), X는 가장 늦음.
    await c.conv.schema.pool.query("UPDATE attachments SET created_at = now() - interval '30 seconds' WHERE id = ANY($1::uuid[])", [[Y, Z]]);
    await c.conv.schema.pool.query("UPDATE attachments SET created_at = now() - interval '10 seconds' WHERE id = $1", [X]);
    await c.conv.schema.pool.query('UPDATE attachments SET message_id = $2 WHERE id = ANY($1::uuid[])', [[X, Y, Z], messageId]);

    const hist = historyResponseSchema.parse((await req(c.conv.app, 'GET', `/api/conversations/${channel}/messages`, a)).json());
    const [first, second] = [Y, Z].sort();
    expect(idsOf(hist.messages.find((m) => m.id === messageId) ?? { attachments: [] })).toEqual([first, second, X]);
  });

  it('봇 게시 경로도 요청 순서다', async () => {
    lc = await setupBotListener();
    const ctx = lc;
    const dm = ctx.bot.dmConversationId;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const up = await botUpload(ctx, dm, png(2 + i, 3), 'image/png');
      expect(up.status).toBe(201);
      ids.push((up.json as { attachment_id: string }).attachment_id);
    }
    await spreadCreatedAt(ctx.conv.schema, ids);
    const [A, B, C] = ids as [string, string, string];
    const sent = await bot(ctx, 'POST', `conversations/${dm}/messages`, { client_message_id: randomUUID(), body: '봇 첨부', attachment_ids: [B, C, A] });
    expect(sent.status).toBe(201);
    const message = messageWriteResponseSchema.parse(sent.json).message;
    expect(idsOf(message)).toEqual([B, C, A]);
    const hist = await bot(ctx, 'GET', `conversations/${dm}/messages`);
    expect(hist.status).toBe(200);
    const listed = historyResponseSchema.parse(hist.json).messages.find((m) => m.id === message.id);
    expect(idsOf(listed ?? { attachments: [] })).toEqual([B, C, A]);
  });
});
