import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bot, botUpload, count, http, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { HTML, mp3, png } from './att-harness.js';

/** 봇 첨부 라우트(TRD §5-2 6·7항): 사람 라우트와 같은 판정·헤더·assertAccess, 업로드 10건/분. */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

const stored = (ctx: BotListenerContext) => count(ctx, 'SELECT count(*)::int AS n FROM attachments WHERE uploader_id = $1', [ctx.bot.botUserId]);

describe('봇 첨부', () => {
  it('봇은 참여 DM에 mp3를 올려 결속하고 같은 헤더로 내려받으며 위장 형식은 415다', async () => {
    const dm = lc.bot.dmConversationId;
    const up = await botUpload(lc, dm, mp3(), 'audio/mpeg');
    expect(up.status).toBe(201);
    const id = up.json.attachment_id as string;
    expect((await botUpload(lc, dm, HTML, 'audio/mpeg')).status).toBe(415);
    const sent = await bot(lc, 'POST', `conversations/${dm}/messages`, { client_message_id: randomUUID(), body: 'briefing.mp3', attachment_ids: [id] });
    expect(sent.status).toBe(201);
    expect(sent.json.message.attachments).toEqual([expect.objectContaining({ id, mime: 'audio/mpeg', expired: false })]);
    const res = await http(lc.botPort, 'GET', `/api/bot/v1/attachments/${id}`, { authorization: `Bearer ${lc.token}`, range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await stored(lc)).toBe(1);
  });

  it('업로드는 10건/분까지 저장되고 11번째는 429 + Retry-After이며 저장 0이다', async () => {
    const dm = lc.bot.dmConversationId;
    for (let i = 0; i < 10; i += 1) expect((await botUpload(lc, dm, png(), 'image/png')).status).toBe(201);
    const over = await botUpload(lc, dm, png(), 'image/png');
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(await stored(lc)).toBe(10);
  });
});
