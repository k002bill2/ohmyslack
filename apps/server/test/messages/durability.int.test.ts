import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { createPgConversationsStore } from '../../src/modules/conversations/index.js';
import { createPgMessagesStore } from '../../src/modules/messages/index.js';
import { testApp } from '../support/auth-app.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { history, sendRaw } from './msg-int-harness.js';

/** FR-MSG-02 보조(DEV_DESIGN §6-2): 커밋 후에만 성공 응답, 주입한 롤백은 오류 응답·행 0·이벤트 0, 앱 재기동 후 확인된 본문 조회. */
let ctx: ConvIntContext;
const extra: FastifyInstance[] = [];

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  for (const app of extra.splice(0)) await app.close();
  await teardownConvInt(ctx);
});

/** change 기록 직전에 실패하는 풀: 메시지·mention insert 이후 같은 트랜잭션 안에서 예외 → 롤백. */
function failingPool(pool: pg.Pool): pg.Pool {
  const connect = async () => {
    const client = await pool.connect();
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    return Object.assign(Object.create(client) as pg.PoolClient, {
      query: (sql: unknown, ...rest: unknown[]) =>
        typeof sql === 'string' && sql.startsWith('INSERT INTO conversation_changes') ? Promise.reject(new Error('injected')) : query(sql, ...rest),
      release: () => client.release(),
    });
  };
  return Object.assign(Object.create(pool) as pg.Pool, { connect, query: pool.query.bind(pool) });
}

async function appWith(pool: pg.Pool): Promise<FastifyInstance> {
  const app = testApp({
    authStore: createPgAuthStore(ctx.schema.pool),
    conversationsStore: createPgConversationsStore(ctx.schema.pool),
    messagesStore: createPgMessagesStore(pool),
  });
  extra.push(app);
  await app.ready();
  return app;
}

const counts = async (): Promise<unknown> =>
  (
    await ctx.schema.pool.query(
      `SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM message_mentions) AS mentions,
              (SELECT count(*) FROM conversation_changes) AS changes, (SELECT last_seq FROM conversations LIMIT 1) AS seq,
              (SELECT last_change_id FROM sync_clock) AS clock`,
    )
  ).rows[0];

describe('저장 내구성', () => {
  it('롤백된 전송은 5xx이고 messages·mention·change·seq·이벤트가 모두 0이다', async () => {
    const a = await as(ctx.app, 'a');
    const general = await createChannel(ctx.app, a, 'general');
    const before = await counts();
    const app = await appWith(failingPool(ctx.schema.pool));
    const events: unknown[] = [];
    for (const name of ['created', 'updated', 'deleted'] as const) app.messageEvents.on(name, (e) => events.push(e));
    const res = await sendRaw(app, await as(app, 'a'), general, { body: '롤백될 본문', mention_user_ids: [ctx.ids.b] });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('롤백될 본문');
    expect(await counts()).toEqual(before);
    expect(events).toHaveLength(0);
  });

  it('created 이벤트 시점에 다른 연결에서 행이 이미 보이고(커밋 후), 앱 재기동 뒤에도 확인된 본문을 조회한다', async () => {
    const a = await as(ctx.app, 'a');
    const general = await createChannel(ctx.app, a, 'general');
    const seen: Promise<number>[] = [];
    ctx.app.messageEvents.on('created', (e) => {
      seen.push(ctx.schema.pool.query('SELECT 1 FROM messages WHERE id = $1', [e.message.id]).then((r) => r.rowCount ?? 0));
    });
    const res = await sendRaw(ctx.app, a, general, { body: '확인된 본문' });
    expect(res.statusCode).toBe(201);
    expect(await Promise.all(seen)).toEqual([1]);
    await ctx.app.close();
    const restarted = await appWith(ctx.schema.pool);
    const page = await history(restarted, await as(restarted, 'a'), general);
    expect(page.messages.map((m) => m.body)).toEqual(['확인된 본문']);
  });
});
