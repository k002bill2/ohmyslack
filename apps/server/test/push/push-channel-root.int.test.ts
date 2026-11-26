import { afterEach, describe, expect, it } from 'vitest';
import { createChannel } from '../conversations/conv-int-harness.js';
import { markRead } from '../sync/sync-int-harness.js';
import { createPgPushStore } from '../../src/modules/push/index.js';
import { as, decrypt, device, flush, req, sendAs, setupPushInt, subscribe, teardownPushInt, type PushIntContext, type Session } from './push-harness.js';

/** FR-CLIENT-05(TRD §6-2): 채널 최상위 봇 게시 → 채널 사람 멤버 전원, 전송 전 삭제된 메시지는 보내지 않는다. */
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
async function subscribedChannel(): Promise<ChannelFixture> {
  const c = (ctx = await setupPushInt());
  const a = await as(c.conv.app, 'a');
  const b = await as(c.conv.app, 'b');
  const channel = await createChannel(c.conv.app, a, 'push-root-room');
  expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/join`, b)).statusCode).toBe(200);
  expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/bots`, a, { bot_user_id: c.botUserId })).statusCode).toBe(201);
  await subscribe(c, a, device('a'));
  await subscribe(c, b, device('b'));
  return { c, a, b, channel };
}

async function seqOf(c: PushIntContext, messageId: string): Promise<number> {
  const res = await c.conv.schema.pool.query<{ seq: string }>('SELECT seq::text FROM messages WHERE id = $1', [messageId]);
  return Number(res.rows[0]?.seq);
}

async function removeAsBot(c: PushIntContext, messageId: string): Promise<void> {
  const services = c.conv.app.domainServices;
  if (services === undefined) throw new Error('도메인 서비스 없음');
  await services.messages.remove(c.botUserId, messageId);
}

describe('FR-CLIENT-05 Web Push — 채널 최상위 봇 게시', () => {
  it('채널 최상위 봇 게시는 채널 사람 멤버 구독 전부에 1건씩 보낸다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const b = await as(c.conv.app, 'b');
    const channel = await createChannel(c.conv.app, a, 'push-root-room');
    expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/join`, b)).statusCode).toBe(200);
    expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/bots`, a, { bot_user_id: c.botUserId })).statusCode).toBe(201);
    await subscribe(c, a, device('a'));
    const bDevice = device('b');
    await subscribe(c, b, bDevice);
    const post = await sendAs(c, c.botUserId, channel);
    await flush(c);
    expect(c.received).toHaveLength(2);
    expect(c.received.some((r) => r.path.includes('-a-'))).toBe(true);
    const bReq = c.received.find((r) => r.path.includes('-b-'));
    const payload = JSON.parse(decrypt(bDevice, bReq?.body ?? Buffer.alloc(0))) as Record<string, unknown>;
    expect(payload).toEqual({ v: 1, kind: 'message', conversation_id: channel, message_id: post, from_bot: true });
  });

  it('채널 최상위 사람 게시(멘션 없음)는 보내지 않는다', async () => {
    const { c, channel } = await subscribedChannel();
    await sendAs(c, c.conv.ids.a, channel);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('그 seq까지 이미 읽은 멤버는 빼고 다른 멤버에게만 보낸다', async () => {
    const { c, a, channel } = await subscribedChannel();
    const post = await sendAs(c, c.botUserId, channel);
    await markRead(c.conv.app, a, channel, await seqOf(c, post));
    await flush(c);
    expect(c.received).toHaveLength(1);
    expect(c.received[0]?.path).toContain('-b-');
  });

  it('채널을 나간 멤버에게는 보내지 않는다', async () => {
    const { c, b, channel } = await subscribedChannel();
    expect((await req(c.conv.app, 'DELETE', `/api/conversations/${channel}/membership`, b)).statusCode).toBeLessThan(300);
    await sendAs(c, c.botUserId, channel);
    await flush(c);
    expect(c.received).toHaveLength(1);
    expect(c.received[0]?.path).toContain('-a-');
  });
});

describe('FR-CLIENT-05 Web Push — 전송 전 삭제', () => {
  it('생성 이벤트 예약 뒤 전송 전에 삭제되면 보내지 않는다', async () => {
    const { c, channel } = await subscribedChannel();
    const post = await sendAs(c, c.botUserId, channel);
    await removeAsBot(c, post);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('멘션 알림도 예약 뒤 전송 전에 삭제되면 보내지 않는다', async () => {
    const { c, channel } = await subscribedChannel();
    const post = await sendAs(c, c.conv.ids.a, channel, { mentionUserIds: [c.conv.ids.b] });
    const services = c.conv.app.domainServices;
    if (services === undefined) throw new Error('도메인 서비스 없음');
    await services.messages.remove(c.conv.ids.a, post);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('대상 질의는 삭제된 메시지에 대해 0건을 돌려준다', async () => {
    const { c, channel } = await subscribedChannel();
    const post = await sendAs(c, c.botUserId, channel);
    const store = createPgPushStore(c.conv.schema.pool);
    const query = {
      conversationId: channel, messageId: post, threadRootId: null, seq: await seqOf(c, post), everyone: true,
      userIds: [], authorId: c.botUserId, keyId: c.config.keyId, now: new Date(c.now),
    };
    expect(await store.targets(query)).toHaveLength(2);
    await removeAsBot(c, post);
    expect(await store.targets(query)).toEqual([]);
  });

  it('대상 2개 중 첫 전송 뒤 삭제되면 두 번째는 보내지 않는다', async () => {
    const { c, channel } = await subscribedChannel();
    const post = await sendAs(c, c.botUserId, channel);
    let removed = false;
    c.afterSend = async () => {
      if (removed) return;
      removed = true;
      await removeAsBot(c, post);
    };
    await flush(c);
    expect(removed).toBe(true);
    expect(c.received).toHaveLength(1);
  });
});
