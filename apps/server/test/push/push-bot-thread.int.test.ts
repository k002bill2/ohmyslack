import { afterEach, describe, expect, it } from 'vitest';
import { createChannel } from '../conversations/conv-int-harness.js';
import { PUSH_COALESCE_WINDOW_MS } from '../../src/shared.js';
import { markRead } from '../sync/sync-int-harness.js';
import { as, decrypt, device, flush, req, sendAs, setupPushInt, subscribe, teardownPushInt, type Device, type PushIntContext, type Session } from './push-harness.js';

/**
 * FR-CLIENT-05 ②(TRD §6-2): 봇 원문 스레드(날짜별 브리핑 스레드)의 봇 답글이 브리핑([BR-)·점검([알림])·결정 요청이면
 * 그 대화의 사람 멤버 전원, 사람 원문이면 원문 작성자만. 진행 표시는 0.
 */
const BRIEFING = '[BR-000018] 아침 브리핑 2026-11-28\n오늘 일정 3건';
const NOTICE = '[알림] 카톡 요약 검수 실패 1건';
const CLARIFY = '❓ 어느 쪽으로 진행할까요?';
const DATE_ROOT = '📅 2026-11-28 (토) 브리핑·카톡 요약';
let ctx: PushIntContext | undefined;

afterEach(async () => {
  await teardownPushInt(ctx);
  ctx = undefined;
});

interface Fixture {
  readonly c: PushIntContext;
  readonly a: Session;
  readonly b: Session;
  readonly aDevice: Device;
  readonly bDevice: Device;
  readonly channel: string;
}

/** 채널(owner A + 멤버 B + 봇), A·B 모두 구독. */
async function channelWithBot(): Promise<Fixture> {
  const c = (ctx = await setupPushInt());
  const a = await as(c.conv.app, 'a');
  const b = await as(c.conv.app, 'b');
  const channel = await createChannel(c.conv.app, a, 'agent-briefs');
  expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/join`, b)).statusCode).toBe(200);
  expect((await req(c.conv.app, 'POST', `/api/conversations/${channel}/bots`, a, { bot_user_id: c.botUserId })).statusCode).toBe(201);
  const aDevice = device('a');
  const bDevice = device('b');
  await subscribe(c, a, aDevice);
  await subscribe(c, b, bDevice);
  return { c, a, b, aDevice, bDevice, channel };
}

/** 앞 전송이 채운 묶음 창을 넘긴다 — 판정이 60초 묶음에 가려지지 않게. */
function pastWindow(c: PushIntContext): void {
  c.received.splice(0);
  c.now += PUSH_COALESCE_WINDOW_MS + 1_000;
}

async function seqOf(c: PushIntContext, messageId: string): Promise<number> {
  const res = await c.conv.schema.pool.query<{ seq: string }>('SELECT seq::text FROM messages WHERE id = $1', [messageId]);
  return Number(res.rows[0]?.seq);
}

function payloadOf(d: Device, body: Buffer | undefined): Record<string, unknown> {
  return JSON.parse(decrypt(d, body ?? Buffer.alloc(0))) as Record<string, unknown>;
}

describe('FR-CLIENT-05 Web Push — 봇 원문 스레드 브리핑·점검 답글', () => {
  it('채널 봇 원문 스레드의 봇 [BR- 답글은 채널 사람 멤버 전원에게 thread_root_id와 함께 1건씩 보낸다', async () => {
    const { c, aDevice, bDevice, channel } = await channelWithBot();
    const root = await sendAs(c, c.botUserId, channel, { body: DATE_ROOT });
    await flush(c);
    pastWindow(c);
    const reply = await sendAs(c, c.botUserId, channel, { threadRootId: root, body: BRIEFING });
    await flush(c);
    expect(c.received).toHaveLength(2);
    const a = c.received.find((r) => r.path.includes('-a-'));
    const b = c.received.find((r) => r.path.includes('-b-'));
    const expected = { v: 1, kind: 'message', conversation_id: channel, message_id: reply, thread_root_id: root, from_bot: true };
    expect(payloadOf(aDevice, a?.body)).toEqual(expected);
    expect(payloadOf(bDevice, b?.body)).toEqual(expected);
  });

  it('같은 봇 원문 스레드에서 진행 표시는 0건, [알림]·❓ 답글은 전원에게 보낸다', async () => {
    const { c, channel } = await channelWithBot();
    const root = await sendAs(c, c.botUserId, channel, { body: DATE_ROOT });
    await flush(c);
    pastWindow(c);
    await sendAs(c, c.botUserId, channel, { threadRootId: root, body: '💻 Running git status' });
    await sendAs(c, c.botUserId, channel, { threadRootId: root, body: '# 카카오톡 오픈채팅 요약 2026-11-28' });
    await flush(c);
    expect(c.received).toHaveLength(0);
    c.now += PUSH_COALESCE_WINDOW_MS + 1_000;
    await sendAs(c, c.botUserId, channel, { threadRootId: root, body: NOTICE });
    await flush(c);
    expect(c.received).toHaveLength(2);
    pastWindow(c);
    await sendAs(c, c.botUserId, channel, { threadRootId: root, body: CLARIFY });
    await flush(c);
    expect(c.received).toHaveLength(2);
  });

  it('Jarvis DM 봇 원문 스레드의 봇 [BR- 답글은 DM 사람 멤버에게 1건 보낸다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const d = device('a');
    await subscribe(c, a, d);
    const root = await sendAs(c, c.botUserId, c.botDm, { body: DATE_ROOT });
    await flush(c);
    pastWindow(c);
    const reply = await sendAs(c, c.botUserId, c.botDm, { threadRootId: root, body: BRIEFING });
    await flush(c);
    expect(c.received).toHaveLength(1);
    expect(payloadOf(d, c.received[0]?.body)).toEqual({ v: 1, kind: 'message', conversation_id: c.botDm, message_id: reply, thread_root_id: root, from_bot: true });
  });

  it('사람 원문 스레드의 봇 [BR- 답글은 원문 작성자에게만 보낸다', async () => {
    const { c, channel } = await channelWithBot();
    const root = await sendAs(c, c.conv.ids.b, channel);
    await flush(c);
    pastWindow(c);
    await sendAs(c, c.botUserId, channel, { threadRootId: root, body: BRIEFING });
    await flush(c);
    expect(c.received).toHaveLength(1);
    expect(c.received[0]?.path).toContain('-b-');
  });

  it('사람이 봇 원문 스레드에 단 [알림] 답글은 보내지 않는다(사람 채널 글은 멘션만)', async () => {
    const { c, channel } = await channelWithBot();
    const root = await sendAs(c, c.botUserId, channel, { body: DATE_ROOT });
    await flush(c);
    pastWindow(c);
    await sendAs(c, c.conv.ids.a, channel, { threadRootId: root, body: NOTICE });
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('그 스레드를 답글 seq까지 이미 읽은 멤버에게는 보내지 않는다', async () => {
    const { c, a, channel } = await channelWithBot();
    const root = await sendAs(c, c.botUserId, channel, { body: DATE_ROOT });
    await flush(c);
    pastWindow(c);
    const reply = await sendAs(c, c.botUserId, channel, { threadRootId: root, body: BRIEFING });
    await markRead(c.conv.app, a, channel, await seqOf(c, reply), root);
    await flush(c);
    expect(c.received).toHaveLength(1);
    expect(c.received[0]?.path).toContain('-b-');
  });
});
