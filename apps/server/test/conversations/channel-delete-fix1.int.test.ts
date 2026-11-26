import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgConversationsStore } from '../../src/modules/conversations/index.js';
import { createPgPushStore } from '../../src/modules/push/index.js';
import { bot as botCall, botUpload, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { png } from '../attachments/att-harness.js';
import { send } from '../messages/msg-int-harness.js';
import { setupWsInt } from '../realtime/ws-int-harness.js';
import { as, createChannel, req } from './conv-int-harness.js';

/** FR-CONV-06 채널 삭제 수정 라운드 1: 삭제 = 활성 멤버 전원 left_at, 우회 경로(sync·봇·푸시·쓰기) 차단. */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

async function seedDeleted(): Promise<{ cid: string; msgId: string; owner: Awaited<ReturnType<typeof as>>; b: Awaited<ReturnType<typeof as>> }> {
  const app = lc.conv.app;
  const owner = await as(app, 'a');
  const b = await as(app, 'b');
  const cid = await createChannel(app, owner, 'doomed');
  expect((await req(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
  expect((await req(app, 'POST', `/api/conversations/${cid}/bots`, owner, { bot_user_id: lc.bot.botUserId })).statusCode).toBe(201);
  const msg = await send(app, b, cid, { body: 'before delete' });
  expect((await req(app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);
  return { cid, msgId: msg.id, owner, b };
}

describe('FR-CONV-06 삭제 = 멤버십 종료', () => {
  it('삭제 후 사람·봇 멤버 행 전원 left_at IS NOT NULL', async () => {
    const { cid } = await seedDeleted();
    const res = await lc.conv.schema.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
      [cid],
    );
    expect(res.rows[0]?.n).toBe(0);
    const all = await lc.conv.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [cid]);
    expect(all.rows[0]?.n).toBe(3);
  });

  it('사람 sync·봇 sync에 삭제 채널 change 0건, 봇 /me에 삭제 채널 없음', async () => {
    const { cid, b } = await seedDeleted();
    const human = (await req(lc.conv.app, 'GET', '/api/sync?after=0&limit=500', b)).json<{ changes: { conversation_id: string }[] }>();
    expect(human.changes.filter((c) => c.conversation_id === cid)).toEqual([]);
    const botSync = (await botCall(lc, 'GET', 'sync?after=0')).json as { changes: { conversation_id: string }[] };
    expect(botSync.changes.filter((c) => c.conversation_id === cid)).toEqual([]);
    const me = (await botCall(lc, 'GET', 'me')).json as { conversations: { id: string }[] };
    expect(me.conversations.map((c) => c.id)).not.toContain(cid);
  });

  it('삭제 뒤 기존 메시지 PATCH/DELETE·leave·봇 제거·봇 업로드 404', async () => {
    const { cid, msgId, owner, b } = await seedDeleted();
    const app = lc.conv.app;
    expect((await req(app, 'PATCH', `/api/messages/${msgId}`, b, { body: 'edited' })).statusCode).toBe(404);
    expect((await req(app, 'DELETE', `/api/messages/${msgId}`, b)).statusCode).toBe(404);
    expect((await req(app, 'DELETE', `/api/conversations/${cid}/membership`, b)).statusCode).toBe(404);
    expect((await req(app, 'DELETE', `/api/conversations/${cid}/bots/${lc.bot.botUserId}`, owner)).statusCode).toBe(404);
    expect((await botUpload(lc, cid, png(), 'image/png')).status).toBe(404);
  });

  it('푸시 대상 쿼리에 삭제 채널 0', async () => {
    const { cid, msgId } = await seedDeleted();
    const pool = lc.conv.schema.pool;
    const sess = await pool.query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1', [lc.conv.ids.b]);
    await pool.query(
      `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, vapid_key_id, created_at)
       VALUES ($1, $2, $3, 'https://push.invalid/x', 'p', 'a', 'k1', now())`,
      [randomUUID(), lc.conv.ids.b, sess.rows[0]?.id],
    );
    const targets = await createPgPushStore(pool).targets({
      conversationId: cid, messageId: msgId, threadRootId: null, seq: 999, everyone: true, userIds: [], authorId: lc.conv.ids.a, keyId: 'k1', now: new Date(),
    });
    expect(targets).toEqual([]);
  });

  it('0008 CHECK: DM에 deleted_at 직접 UPDATE는 23514', async () => {
    const owner = await as(lc.conv.app, 'a');
    const dm = (await req(lc.conv.app, 'POST', '/api/dms', owner, { user_id: lc.conv.ids.b })).json<{ id: string }>().id;
    await expect(
      lc.conv.schema.pool.query('UPDATE conversations SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [dm, lc.conv.ids.a]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('FR-CONV-06 경쟁(가드 통과 후 삭제 커밋) — store 수준', () => {
  it('삭제 커밋 뒤 store.join·addBot은 deleted를 돌려준다', async () => {
    const { cid } = await seedDeleted();
    const store = createPgConversationsStore(lc.conv.schema.pool);
    expect(await store.join(cid, lc.conv.ids.c, new Date())).toBe('deleted');
    // addBot은 대상 확인(BOT_TARGET_SQL)이 먼저 거른다 — 둘 다 서비스에서 404.
    expect(['deleted', 'invalid_target']).toContain(await store.addBot(cid, lc.bot.botUserId, new Date()));
  });
});

describe('FR-CONV-06 owner가 나간 채널 삭제', () => {
  it('owner의 다른 연결도 conversation.deleted를 받는다', async () => {
    const ws = await setupWsInt();
    try {
      const { app } = ws.conv;
      const owner = await as(app, 'a');
      const owner2 = await as(app, 'a');
      const cid = await createChannel(app, owner, 'gone');
      expect((await req(app, 'DELETE', `/api/conversations/${cid}/membership`, owner)).statusCode).toBe(204);
      const wsOwner2 = await ws.open(owner2.token);
      expect((await req(app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);
      await wsOwner2.waitFor((f) => f.type === 'conversation.deleted' && f.conversation_id === cid, 3000);
    } finally {
      await ws.teardown();
    }
  });
});

describe('FR-CONV-06 먼저 나간 사람 멤버 통지', () => {
  it('사람 멤버가 먼저 나간 뒤 owner가 삭제하면 그 멤버 연결도 conversation.deleted를 받는다', async () => {
    const ws = await setupWsInt();
    try {
      const { app } = ws.conv;
      const owner = await as(app, 'a');
      const b = await as(app, 'b');
      const cid = await createChannel(app, owner, 'left-first');
      expect((await req(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
      expect((await req(app, 'DELETE', `/api/conversations/${cid}/membership`, b)).statusCode).toBe(204);
      const wsB = await ws.open(b.token);
      expect((await req(app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);
      await wsB.waitFor((f) => f.type === 'conversation.deleted' && f.conversation_id === cid, 3000);
    } finally {
      await ws.teardown();
    }
  });
});

describe('FR-CONV-06 복구 정합: 삭제가 찍은 left_at = deleted_at', () => {
  it('삭제로 종료된 멤버 행의 left_at은 conversations.deleted_at과 정확히 같고 먼저 나간 행은 그대로다', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const b = await as(app, 'b');
    const c = await as(app, 'c');
    const cid = await createChannel(app, owner, 'restorable');
    expect((await req(app, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
    expect((await req(app, 'POST', `/api/conversations/${cid}/join`, c)).statusCode).toBe(200);
    expect((await req(app, 'DELETE', `/api/conversations/${cid}/membership`, c)).statusCode).toBe(204);
    expect((await req(app, 'POST', `/api/conversations/${cid}/bots`, owner, { bot_user_id: lc.bot.botUserId })).statusCode).toBe(201);
    expect((await req(app, 'DELETE', `/api/conversations/${cid}`, owner)).statusCode).toBe(204);
    const res = await lc.conv.schema.pool.query<{ user_id: string; same: boolean }>(
      `SELECT m.user_id, m.left_at = c.deleted_at AS same FROM conversation_members m
         JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = $1 ORDER BY m.user_id`,
      [cid],
    );
    const same = new Map(res.rows.map((r) => [r.user_id, r.same]));
    expect(same.get(lc.conv.ids.a)).toBe(true);
    expect(same.get(lc.conv.ids.b)).toBe(true);
    expect(same.get(lc.bot.botUserId)).toBe(true);
    expect(same.get(lc.conv.ids.c)).toBe(false);
  });
});
