import { afterEach, describe, expect, it } from 'vitest';
import { createChannel } from '../conversations/conv-int-harness.js';
import { markRead } from '../sync/sync-int-harness.js';
import { as, decrypt, device, flush, req, sendAs, setupPushInt, subscribe, teardownPushInt, type PushIntContext, type Session } from './push-harness.js';

/** FR-CLIENT-05(TRD §6-2): 채널 스레드에서 봇이 단 답글 → 그 스레드 원문 작성자(사람)에게만 알림. */
let ctx: PushIntContext | undefined;

afterEach(async () => {
  await teardownPushInt(ctx);
  ctx = undefined;
});

interface ChannelFixture {
  readonly c: PushIntContext;
  readonly a: Session;
  readonly b: Session;
  readonly channel: string;
}

/** 채널(owner A + 멤버 B + 봇) 준비, A·B 모두 구독. */
async function channelWithBot(): Promise<ChannelFixture> {
  const c = (ctx = await setupPushInt());
  const a = await as(c.conv.app, 'a');
  const b = await as(c.conv.app, 'b');
  const channel = await createChannel(c.conv.app, a, 'push-bot-room');
  expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/join`, b)).statusCode).toBe(200);
  expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/bots`, a, { bot_user_id: c.botUserId })).statusCode).toBe(201);
  return { c, a, b, channel };
}

async function seqOf(c: PushIntContext, messageId: string): Promise<number> {
  const res = await c.conv.schema.pool.query<{ seq: string }>('SELECT seq::text FROM messages WHERE id = $1', [messageId]);
  return Number(res.rows[0]?.seq);
}

describe('FR-CLIENT-05 Web Push — 채널 스레드 봇 답글', () => {
  it('채널에서 사람 원문에 봇이 답글을 달면 원문 작성자에게만 thread_root_id와 함께 1건 보낸다', async () => {
    const { c, a, b, channel } = await channelWithBot();
    await subscribe(c, a, device('a'));
    const bDevice = device('b');
    await subscribe(c, b, bDevice);
    const root = await sendAs(c, c.conv.ids.b, channel);
    await flush(c);
    expect(c.received).toHaveLength(0); // 사람 최상위 글(멘션 없음) → 0
    const reply = await sendAs(c, c.botUserId, channel, { threadRootId: root });
    await flush(c);
    expect(c.received).toHaveLength(1);
    expect(c.received[0]?.path).toContain('-b-');
    const payload = JSON.parse(decrypt(bDevice, c.received[0]?.body ?? Buffer.alloc(0))) as Record<string, unknown>;
    expect(payload).toEqual({ v: 1, kind: 'message', conversation_id: channel, message_id: reply, thread_root_id: root, from_bot: true });
  });

  it('채널에서 사람이 단 답글(멘션 없음)은 원문 작성자에게 보내지 않는다', async () => {
    const { c, b, channel } = await channelWithBot();
    await subscribe(c, b, device('b'));
    const root = await sendAs(c, c.conv.ids.b, channel);
    await sendAs(c, c.conv.ids.a, channel, { threadRootId: root });
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('채널 최상위 봇 게시는 보내지 않는다', async () => {
    const { c, a, b, channel } = await channelWithBot();
    await subscribe(c, a, device('a'));
    await subscribe(c, b, device('b'));
    await sendAs(c, c.botUserId, channel);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('봇 원문에 봇이 단 답글은 보내지 않는다(원문 작성자가 봇)', async () => {
    const { c, a, b, channel } = await channelWithBot();
    await subscribe(c, a, device('a'));
    await subscribe(c, b, device('b'));
    const root = await sendAs(c, c.botUserId, channel);
    await sendAs(c, c.botUserId, channel, { threadRootId: root });
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('원문 작성자가 그 스레드를 답글 seq까지 이미 읽었으면 보내지 않는다', async () => {
    const { c, b, channel } = await channelWithBot();
    await subscribe(c, b, device('b'));
    const root = await sendAs(c, c.conv.ids.b, channel);
    const reply = await sendAs(c, c.botUserId, channel, { threadRootId: root });
    await markRead(c.conv.app, b, channel, await seqOf(c, reply), root);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });
});
