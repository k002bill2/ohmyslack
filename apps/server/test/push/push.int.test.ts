import { afterEach, describe, expect, it } from 'vitest';
import { PUSH_COALESCE_WINDOW_MS, PUSH_PAYLOAD_KEYS, PUSH_TTL_SECONDS, pushPayloadSchema } from '../../src/shared.js';
import { openDm } from '../conversations/conv-int-harness.js';
import { markRead } from '../sync/sync-int-harness.js';
import {
  as,
  BODY_CANARY,
  decrypt,
  device,
  ENDPOINT_CANARY,
  flush,
  req,
  sendAs,
  setupPushInt,
  subscribe,
  subscriptionBody,
  subscriptionCount,
  teardownPushInt,
  type PushIntContext,
} from './push-harness.js';

/** FR-CLIENT-05 / TR-SEC-15(TRD §6-2): 가짜 push service로 실제 web-push 요청을 받아 본다. 실제 push service 호출 0. */
const CLARIFY = '❓ 어느 쪽으로 진행할까요?\nReply "skip" to skip this question.';
let ctx: PushIntContext | undefined;

afterEach(async () => {
  await teardownPushInt(ctx);
  ctx = undefined;
});

function noCanaryInLogs(c: PushIntContext): void {
  const all = c.logs.join('\n');
  expect(all).not.toContain(ENDPOINT_CANARY);
  expect(all).not.toContain(BODY_CANARY);
}

describe('FR-CLIENT-05 Web Push', () => {
  it('FR-CLIENT-05 구독 기기에 본문 없는 payload로 알림이 1건 전송되고 404·410 구독은 삭제되며 허용목록 밖 endpoint는 등록되지 않는다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const ok = device('ok');
    const gone = device('status-410');
    const missing = device('status-404');
    await subscribe(c, a, ok);
    await subscribe(c, a, gone);
    await subscribe(c, a, missing);
    expect(await subscriptionCount(c)).toBe(3);

    // 허용목록 밖·비 https endpoint는 400이고 저장 0.
    for (const endpoint of [
      'http://web.push.apple.com/x',
      'https://evil.example.com/x',
      'https://push.apple.com.evil.com/x',
      'https://push.apple.com/x',
      'https://web.push.apple.com:8443/x',
    ]) {
      const res = await req(c.conv.app, 'POST', '/api/push/subscriptions', a, subscriptionBody(device(), endpoint));
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
    }
    expect(await subscriptionCount(c)).toBe(3);

    // Jarvis DM 새 원문(본문 = 로그 카나리아) → 기기마다 1건.
    const messageId = await sendAs(c, c.botUserId, c.botDm);
    expect(c.received).toHaveLength(0); // 메시지 생성 경로는 전송을 기다리지 않는다(예약만).
    await flush(c);
    const okRequests = c.received.filter((r) => r.path.includes('-ok-'));
    expect(okRequests).toHaveLength(1);
    expect(c.received).toHaveLength(3);
    const sent = okRequests[0];
    if (sent === undefined) throw new Error('unreachable');
    expect(sent.headers.ttl).toBe(String(PUSH_TTL_SECONDS));
    expect(sent.headers.ttl).toBe('86400');
    expect(sent.headers['content-encoding']).toBe('aes128gcm');
    expect(sent.headers.topic).toBe(c.botDm.replaceAll('-', ''));
    expect(sent.headers.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${c.config.publicKey}$`));
    expect(sent.body.includes(Buffer.from(BODY_CANARY))).toBe(false);

    const plain = decrypt(ok, sent.body);
    expect(plain).not.toContain(BODY_CANARY);
    const payload = JSON.parse(plain) as Record<string, unknown>;
    expect(Object.keys(payload).every((key) => (PUSH_PAYLOAD_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(pushPayloadSchema.parse(payload)).toEqual({ v: 1, kind: 'message', conversation_id: c.botDm, message_id: messageId, from_bot: true });

    // 404·410 응답 구독은 삭제, 성공 구독은 남고 last_success_at 기록.
    const rows = await c.conv.schema.pool.query<{ endpoint: string; last_success_at: Date | null }>('SELECT endpoint, last_success_at FROM push_subscriptions');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.endpoint).toBe(ok.endpoint);
    expect(rows.rows[0]?.last_success_at).not.toBeNull();
    noCanaryInLogs(c);
    expect(c.logs.filter((l) => l.includes('push_send_result'))).toHaveLength(3);
  });

  it('push 비활성이면 vapid-public-key·구독 등록이 404이고 앱은 계속 응답한다', async () => {
    const c = (ctx = await setupPushInt({ enabled: false }));
    const a = await as(c.conv.app, 'a');
    const key = await req(c.conv.app, 'GET', '/api/push/vapid-public-key', a);
    expect(key.statusCode).toBe(404);
    expect(key.json<{ error: { code: string } }>().error.code).toBe('not_found');
    expect((await req(c.conv.app, 'POST', '/api/push/subscriptions', a, subscriptionBody(device()))).statusCode).toBe(404);
    expect(await subscriptionCount(c)).toBe(0);
    expect((await req(c.conv.app, 'GET', '/api/conversations', a)).statusCode).toBe(200);
    await sendAs(c, c.botUserId, c.botDm);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('활성이면 vapid-public-key가 공개키를 돌려주고 비로그인은 401이다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const key = await req(c.conv.app, 'GET', '/api/push/vapid-public-key', a);
    expect(key.statusCode).toBe(200);
    expect(key.json()).toEqual({ public_key: c.config.publicKey });
    expect((await req(c.conv.app, 'GET', '/api/push/vapid-public-key')).statusCode).toBe(401);
  });

  it('같은 endpoint 재등록은 행을 교체하고, 남의 구독 DELETE는 404(행 유지), 자기 구독 DELETE는 204다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const b = await as(c.conv.app, 'b');
    const d = device();
    const first = await subscribe(c, a, d);
    const again = await subscribe(c, b, d);
    expect(again).toBe(first);
    const owner = await c.conv.schema.pool.query<{ user_id: string }>('SELECT user_id FROM push_subscriptions');
    expect(owner.rows).toEqual([{ user_id: c.conv.ids.b }]);
    expect((await req(c.conv.app, 'DELETE', `/api/push/subscriptions/${first}`, a)).statusCode).toBe(404);
    expect((await req(c.conv.app, 'DELETE', '/api/push/subscriptions/not-a-uuid', a)).statusCode).toBe(404);
    expect(await subscriptionCount(c)).toBe(1);
    expect((await req(c.conv.app, 'DELETE', `/api/push/subscriptions/${first}`, b)).statusCode).toBe(204);
    expect(await subscriptionCount(c)).toBe(0);
  });

  it('같은 endpoint·같은 키 재등록은 last_success_at을 유지하고, 키(p256dh·auth)가 바뀌면 NULL로 초기화한다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const d = device();
    await subscribe(c, a, d);
    const at = new Date('2026-11-09T00:00:00Z');
    await c.conv.schema.pool.query('UPDATE push_subscriptions SET last_success_at = $1', [at]);
    const lastSuccess = async (): Promise<Date | null> =>
      (await c.conv.schema.pool.query<{ last_success_at: Date | null }>('SELECT last_success_at FROM push_subscriptions')).rows[0]
        ?.last_success_at ?? null;

    await subscribe(c, a, d); // 앱 재실행마다 같은 구독을 다시 upsert한다(PushSettings init).
    expect((await lastSuccess())?.toISOString()).toBe(at.toISOString());

    const rotated = device(); // 같은 endpoint, 새 키.
    const res = await req(c.conv.app, 'POST', '/api/push/subscriptions', a, subscriptionBody(rotated, d.endpoint));
    expect(res.statusCode).toBe(201);
    expect(await lastSuccess()).toBeNull();
    expect(await subscriptionCount(c)).toBe(1);
  });

  it('자기 메시지는 보내지 않는다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    await subscribe(c, a, device());
    await sendAs(c, c.conv.ids.a, c.botDm);
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('전송 전에 이미 읽은 대화는 보내지 않는다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    await subscribe(c, a, device());
    await sendAs(c, c.botUserId, c.botDm);
    const seq = await c.conv.schema.pool.query<{ last_seq: string }>('SELECT last_seq::text FROM conversations WHERE id = $1', [c.botDm]);
    await markRead(c.conv.app, a, c.botDm, Number(seq.rows[0]?.last_seq));
    await flush(c);
    expect(c.received).toHaveLength(0);
  });

  it('같은 대화 알림은 60초 창 안에서 1건으로 묶고 창이 지나면 다시 보낸다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    await subscribe(c, a, device());
    await sendAs(c, c.botUserId, c.botDm);
    await flush(c);
    c.now += PUSH_COALESCE_WINDOW_MS - 1;
    await sendAs(c, c.botUserId, c.botDm);
    await flush(c);
    expect(c.received).toHaveLength(1);
    c.now += 1;
    await sendAs(c, c.botUserId, c.botDm);
    await flush(c);
    expect(c.received).toHaveLength(2);
  });

  it('로그아웃하면 그 세션의 구독이 삭제된다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    await subscribe(c, a, device());
    expect(await subscriptionCount(c)).toBe(1);
    expect((await req(c.conv.app, 'POST', '/api/auth/logout', a)).statusCode).toBeLessThan(300);
    expect(await subscriptionCount(c)).toBe(0);
  });

  it('사람 DM에서는 멘션 대상에게만 보낸다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const b = await as(c.conv.app, 'b');
    const dm = (await openDm(c.conv.app, a, c.conv.ids.b)).json<{ id: string }>().id;
    const bDevice = device();
    await subscribe(c, b, bDevice);
    await sendAs(c, c.conv.ids.a, dm);
    await flush(c);
    expect(c.received).toHaveLength(0);
    const mentionId = await sendAs(c, c.conv.ids.a, dm, { mentionUserIds: [c.conv.ids.b] });
    await flush(c);
    expect(c.received).toHaveLength(1);
    const payload = JSON.parse(decrypt(bDevice, c.received[0]?.body ?? Buffer.alloc(0))) as Record<string, unknown>;
    expect(payload).toEqual({ v: 1, kind: 'message', conversation_id: dm, message_id: mentionId, from_bot: false });
  });

  it('Jarvis DM 봇 답글은 자기 스레드의 결정 요청일 때만 thread_root_id와 함께 보낸다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    const d = device();
    await subscribe(c, a, d);
    const root = await sendAs(c, c.conv.ids.a, c.botDm);
    const botRoot = await sendAs(c, c.botUserId, c.botDm);
    await flush(c);
    expect(c.received).toHaveLength(1); // botRoot
    c.now += PUSH_COALESCE_WINDOW_MS;
    await sendAs(c, c.botUserId, c.botDm, { threadRootId: botRoot, body: CLARIFY });
    await flush(c);
    expect(c.received).toHaveLength(1); // 남의 스레드 답글 → 0
    const reply = await sendAs(c, c.botUserId, c.botDm, { threadRootId: root, body: CLARIFY });
    await flush(c);
    expect(c.received).toHaveLength(2);
    const payload = JSON.parse(decrypt(d, c.received[1]?.body ?? Buffer.alloc(0))) as Record<string, unknown>;
    expect(payload).toEqual({ v: 1, kind: 'message', conversation_id: c.botDm, message_id: reply, thread_root_id: root, from_bot: true });
  });

  it('Jarvis DM 봇 일반 답글은 보내지 않고 [결정 필요] 답글은 원문 작성자에게 보낸다', async () => {
    const c = (ctx = await setupPushInt());
    const a = await as(c.conv.app, 'a');
    await subscribe(c, a, device());
    const root = await sendAs(c, c.conv.ids.a, c.botDm);
    await flush(c);
    expect(c.received).toHaveLength(0); // 자기 원문
    c.now += PUSH_COALESCE_WINDOW_MS + 1_000;
    await sendAs(c, c.botUserId, c.botDm, { threadRootId: root, body: '⏳ Working — 9 min — iteration 6/90, clarify' });
    await sendAs(c, c.botUserId, c.botDm, { threadRootId: root });
    await sendAs(c, c.botUserId, c.botDm, { threadRootId: root, body: '✅ Command approved' });
    await flush(c);
    expect(c.received).toHaveLength(0);
    await sendAs(c, c.botUserId, c.botDm, { threadRootId: root, body: '[결정 필요] 배포 시간을 정해 주세요' });
    await flush(c);
    expect(c.received).toHaveLength(1);
  });
});
