import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_BODY_MAX } from '../../src/shared.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { sendRaw } from './msg-int-harness.js';

/** FR-MSG-01 보조(DEV_DESIGN §6-2): 빈 메시지·상한+1 code point 저장 0, 상한은 저장(TRD §5 상수). */
let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

const rows = async (): Promise<number> => Number((await ctx.schema.pool.query<{ n: string }>('SELECT count(*) AS n FROM messages')).rows[0]?.n);

describe('본문 상한', () => {
  it('빈 메시지·공백만·상한+1 code point는 400이고 저장 0, 상한 code point(서로게이트 쌍 포함)는 저장된다', async () => {
    const a = await as(ctx.app, 'a');
    const general = await createChannel(ctx.app, a, 'general');
    for (const body of ['', '   \n', 'a'.repeat(MESSAGE_BODY_MAX + 1), '😀'.repeat(MESSAGE_BODY_MAX + 1)]) {
      const res = await sendRaw(ctx.app, a, general, { body });
      expect(res.statusCode, `${body.length}`).toBe(400);
      expect(res.body).not.toContain(body.slice(0, 20) || 'x'.repeat(30));
    }
    expect(await rows()).toBe(0);
    // 상한: UTF-16 길이는 상한의 2배여도 code point로는 상한이므로 저장된다.
    const emoji = '😀'.repeat(MESSAGE_BODY_MAX);
    const res = await sendRaw(ctx.app, a, general, { body: emoji });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ message: { body: string } }>().message.body).toBe(emoji);
    expect((await sendRaw(ctx.app, a, general, { body: '가'.repeat(MESSAGE_BODY_MAX) })).statusCode).toBe(201);
    expect(await rows()).toBe(2);
  });
});
