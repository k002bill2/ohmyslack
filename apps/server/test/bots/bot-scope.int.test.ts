import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotEvents, createBotService, type CreatedBot } from '../../src/modules/bots/index.js';
import { as, createChannel, openDm, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { bot as botCall, count, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';

/**
 * 봇 참여 범위 경계(TRD §5-2 5항: owner DM + owner가 추가한 채널, Codex r1 P1·P2).
 * 봇 DM은 CLI create가 만드는 owner DM만, 봇 비활성화는 CLI disable만 — 사람 API는 없는 상대와 같은 거부.
 */
let ctx: ConvIntContext;
let bot: CreatedBot;

beforeEach(async () => {
  ctx = await setupConvInt();
  const service = createBotService({ pool: ctx.schema.pool, events: createBotEvents() });
  bot = await service.createBot({ displayName: 'Scope Bot', slug: 'scope-bot' });
  await service.issueToken(bot.botUserId, 'scope');
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

/** request_id는 요청마다 달라 비교에서 뺀다(나머지 본문·키는 같아야 한다). */
function shape(body: { error: Record<string, unknown> }): unknown {
  const rest = Object.fromEntries(Object.entries(body.error).filter(([k]) => k !== 'request_id'));
  return { keys: Object.keys(body.error).sort(), ...rest };
}

async function dmsWithBot(): Promise<number> {
  const res = await ctx.schema.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM conversations c
      WHERE c.kind = 'dm' AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1)`,
    [bot.botUserId],
  );
  return res.rows[0]?.n ?? -1;
}

describe('사람 API의 봇 범위 경계', () => {
  it('일반 멤버·owner 모두 봇 id로 DM을 열면 없는 상대와 같은 400이고 봇 DM은 CLI owner DM 1개뿐이다', async () => {
    expect(await dmsWithBot()).toBe(1);
    const unknown = await openDm(ctx.app, await as(ctx.app, 'b'), '00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(400);
    for (const who of ['b', 'a'] as const) {
      const res = await openDm(ctx.app, await as(ctx.app, who), bot.botUserId);
      expect(res.statusCode).toBe(unknown.statusCode);
      expect(shape(res.json())).toEqual(shape(unknown.json()));
    }
    expect(await dmsWithBot()).toBe(1);
    const owner = await ctx.schema.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
      [bot.dmConversationId],
    );
    expect(owner.rows[0]?.n).toBe(2);
  });

  it('owner가 봇 id로 원격 비활성화하면 없는 대상과 같은 404이고 상태·미폐기 토큰 수가 그대로다', async () => {
    const a = await as(ctx.app, 'a');
    const unknown = await req(ctx.app, 'POST', '/api/admin/members/00000000-0000-4000-8000-000000000000/deactivate', a);
    expect(unknown.statusCode).toBe(404);
    const res = await req(ctx.app, 'POST', `/api/admin/members/${bot.botUserId}/deactivate`, a);
    expect(res.statusCode).toBe(unknown.statusCode);
    expect(shape(res.json())).toEqual(shape(unknown.json()));
    const state = await ctx.schema.pool.query<{ status: string; live: number }>(
      `SELECT u.status, (SELECT count(*)::int FROM bot_tokens t WHERE t.bot_user_id = u.id AND t.revoked_at IS NULL) AS live
         FROM users u WHERE u.id = $1`,
      [bot.botUserId],
    );
    expect(state.rows[0]).toEqual({ status: 'active', live: 1 });
  });
});

describe('봇 리스너 멤버십 상한(§5-2 5항)', () => {
  let lc: BotListenerContext;

  beforeEach(async () => {
    lc = await setupBotListener();
  });

  afterEach(async () => {
    await teardownBotListener(lc);
  });

  const msg = (body: string, root?: string) => ({ client_message_id: randomUUID(), body, ...(root === undefined ? {} : { thread_root_id: root }) });

  it('봇은 참여하지 않은 대화의 이력·답글·쓰기·수정·snapshot·read-state가 404이고 sync에 0건이며 저장도 0이다', async () => {
    const owner = await as(lc.conv.app, 'a');
    const channel = await createChannel(lc.conv.app, owner, 'secret');
    const root = (await req(lc.conv.app, 'POST', `/api/conversations/${channel}/messages`, owner, msg('비밀'))).json<{ message: { id: string } }>().message.id;
    const before = await count(lc, 'SELECT count(*)::int AS n FROM messages', []);
    const checks: [string, string, unknown?][] = [
      ['GET', `conversations/${channel}/messages`],
      ['GET', `messages/${root}/replies`],
      ['POST', `conversations/${channel}/messages`, msg('침입')],
      ['POST', `conversations/${channel}/messages`, msg('침입 답글', root)],
      ['PATCH', `messages/${root}`, { body: '변조' }],
      ['GET', `sync/snapshot?conversation_id=${channel}`],
      ['PUT', 'read-state', { conversation_id: channel, last_read_seq: 1 }],
    ];
    for (const [method, path, body] of checks) {
      const res = await botCall(lc, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.json).includes('비밀'), `${method} ${path}`).toBe(false);
    }
    expect(await count(lc, 'SELECT count(*)::int AS n FROM messages', [])).toBe(before);
    expect(await count(lc, "SELECT count(*)::int AS n FROM messages WHERE body = '비밀'", [])).toBe(1);
    const sync = await botCall(lc, 'GET', 'sync?after=0');
    expect(sync.status).toBe(200);
    expect(sync.json.changes.filter((c: { conversation_id: string }) => c.conversation_id === channel)).toEqual([]);
    expect((await botCall(lc, 'POST', 'dms', { user_id: lc.conv.ids.b })).status).toBe(404);
  });

  it('me.conversation_ids는 활성 참여 대화만이고 owner_user_id는 워크스페이스 owner다', async () => {
    const owner = await as(lc.conv.app, 'a');
    const left = await createChannel(lc.conv.app, owner, 'left-channel');
    await lc.conv.schema.pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq, left_at) VALUES ($1, $2, now(), 0, now())',
      [left, lc.bot.botUserId],
    );
    const me = await botCall(lc, 'GET', 'me');
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ id: lc.bot.botUserId, owner_user_id: lc.conv.ids.a, conversation_ids: [lc.bot.dmConversationId] });
    expect((await botCall(lc, 'GET', `conversations/${left}/messages`)).status).toBe(404);
  });

  it('봇 메시지의 author_kind는 서버가 bot으로 정하고 sync change는 op를 싣는다', async () => {
    const dm = lc.bot.dmConversationId;
    const created = await botCall(lc, 'POST', `conversations/${dm}/messages`, { ...msg('안녕'), author_kind: 'human' });
    expect(created.status).toBe(400);
    const ok = await botCall(lc, 'POST', `conversations/${dm}/messages`, msg('안녕'));
    expect(ok.status).toBe(201);
    expect(ok.json.message.author_kind).toBe('bot');
    const owner = await as(lc.conv.app, 'a');
    await req(lc.conv.app, 'POST', `/api/conversations/${dm}/messages`, owner, msg('지시'));
    const edited = await botCall(lc, 'PATCH', `messages/${ok.json.message.id}`, { body: '안녕!' });
    expect(edited.status).toBe(200);
    const history = await botCall(lc, 'GET', `conversations/${dm}/messages`);
    expect(history.json.messages.map((m: { author_kind: string }) => m.author_kind)).toEqual(['bot', 'human']);
    const first = await botCall(lc, 'GET', `sync?after=0&through=${ok.json.change_id}`);
    expect(first.json.changes.map((c: { op: string; message: { author_kind: string } }) => [c.op, c.message.author_kind])).toEqual([['create', 'bot']]);
    const all = await botCall(lc, 'GET', 'sync?after=0');
    expect(all.json.changes.map((c: { op: string; message: { author_kind: string } }) => [c.op, c.message.author_kind])).toEqual([
      ['create', 'human'],
      ['edit', 'bot'],
    ]);
    const snap = await botCall(lc, 'GET', `sync/snapshot?conversation_id=${dm}`);
    expect(snap.status).toBe(200);
    expect(snap.json.messages).toHaveLength(2);
  });
});
