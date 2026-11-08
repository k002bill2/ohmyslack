import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bot, count, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';

/** 봇 토큰별 rate limit(TRD §5-2 7항, FR-BOT-05 보조)과 client_message_id 멱등(어댑터 재시도 근거). */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

const msg = (body: string, id = randomUUID()) => ({ client_message_id: id, body });
const messages = (ctx: BotListenerContext) => count(ctx, 'SELECT count(*)::int AS n FROM messages WHERE author_id = $1', [ctx.bot.botUserId]);

describe('봇 rate limit', () => {
  it('동시 생성 40건 중 정확히 30건만 저장되고 나머지는 429 + Retry-After', async () => {
    const path = `conversations/${lc.bot.dmConversationId}/messages`;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => bot(lc, 'POST', path, msg(`m${i}`))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(30);
    const limited = results.filter((r) => r.status === 429);
    expect(limited).toHaveLength(10);
    for (const r of limited) {
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(r.json.error.code).toBe('rate_limited');
    }
    expect(await messages(lc)).toBe(30);
  });

  it('수정은 60건까지 허용되고 61번째는 429이며 본문이 바뀌지 않는다', async () => {
    const created = await bot(lc, 'POST', `conversations/${lc.bot.dmConversationId}/messages`, msg('v0'));
    const id = created.json.message.id as string;
    for (let i = 1; i <= 60; i += 1) expect((await bot(lc, 'PATCH', `messages/${id}`, { body: `v${i}` })).status).toBe(200);
    const over = await bot(lc, 'PATCH', `messages/${id}`, { body: 'over' });
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const row = await lc.conv.schema.pool.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [id]);
    expect(row.rows[0]?.body).toBe('v60');
  });
});

describe('봇 client_message_id 멱등', () => {
  it('같은 id 재전송은 원결과(200·같은 메시지), 다른 payload는 409이고 저장은 1건', async () => {
    const path = `conversations/${lc.bot.dmConversationId}/messages`;
    const id = randomUUID();
    const first = await bot(lc, 'POST', path, msg('한 번', id));
    expect(first.status).toBe(201);
    const again = await bot(lc, 'POST', path, msg('한 번', id));
    expect(again.status).toBe(200);
    expect(again.json.message.id).toBe(first.json.message.id);
    expect(again.json.change_id).toBe(first.json.change_id);
    const conflict = await bot(lc, 'POST', path, msg('다른 본문', id));
    expect(conflict.status).toBe(409);
    expect(await messages(lc)).toBe(1);
  });
});
