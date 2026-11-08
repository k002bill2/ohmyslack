import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgMessagesStore } from '../../src/modules/messages/index.js';
import { historyResponseSchema, messageWriteResponseSchema, snapshotResponseSchema, syncResponseSchema } from '../../src/shared.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { sendRaw } from './msg-int-harness.js';

/** author_kind는 서버가 users.kind에서 결정해 모든 메시지 projection에 싣는다(TRD §5-2 8). */
let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

/** 봇 행은 인증 경로 없이 직접 만든다: kind 'bot'·password_hash NULL·워크스페이스·대화 멤버. */
async function addBotMember(conversationId: string, slug: string): Promise<string> {
  const id = randomUUID();
  await ctx.schema.pool.query(
    "INSERT INTO users (id, email_norm, display_name, password_hash, status, kind) VALUES ($1, $2, $3, NULL, 'active', 'bot')",
    [id, `${slug}@bot.invalid`, slug],
  );
  await ctx.schema.pool.query("INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, $1, 'member' FROM workspaces LIMIT 1", [id]);
  await ctx.schema.pool.query(
    'INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq) SELECT $1, $2, now(), last_seq FROM conversations WHERE id = $1',
    [conversationId, id],
  );
  return id;
}

async function sendAsBot(conversationId: string, botId: string, body: string): Promise<string> {
  const id = randomUUID();
  const result = await createPgMessagesStore(ctx.schema.pool).send({
    id,
    conversationId,
    authorId: botId,
    clientMessageId: randomUUID(),
    threadRootId: null,
    body,
    mentionUserIds: [],
    at: new Date(),
  });
  if (result.kind !== 'created') throw new Error(`봇 전송 실패: ${result.kind}`);
  return id;
}

describe('메시지 projection author_kind', () => {
  it('사람이 쓴 메시지와 봇이 쓴 메시지를 쓰기 응답·이력·sync 변경·snapshot에서 구분한다', async () => {
    const a = await as(ctx.app, 'a');
    const channel = await createChannel(ctx.app, a, 'general');
    const written = await sendRaw(ctx.app, a, channel, { body: '사람' });
    expect(written.statusCode).toBe(201);
    const human = messageWriteResponseSchema.parse(written.json()).message;
    expect(human.author_kind).toBe('human');
    const botId = await addBotMember(channel, 'jarvis');
    const botMessageId = await sendAsBot(channel, botId, '봇');

    const kinds = (messages: readonly { id: string; author_kind: string }[]): Record<string, string> =>
      Object.fromEntries(messages.map((m) => [m.id, m.author_kind]));
    const expected = { [human.id]: 'human', [botMessageId]: 'bot' };

    const hist = await req(ctx.app, 'GET', `/api/conversations/${channel}/messages`, a);
    expect(hist.statusCode).toBe(200);
    expect(kinds(historyResponseSchema.parse(hist.json()).messages)).toEqual(expected);

    const sync = await req(ctx.app, 'GET', '/api/sync?after=0&limit=500', a);
    expect(sync.statusCode).toBe(200);
    expect(kinds(syncResponseSchema.parse(sync.json()).changes.map((c) => c.message))).toEqual(expected);

    const snap = await req(ctx.app, 'GET', `/api/sync/snapshot?conversation_id=${channel}`, a);
    expect(snap.statusCode).toBe(200);
    expect(kinds(snapshotResponseSchema.parse(snap.json()).messages)).toEqual(expected);
  });

  it('요청 본문의 author_kind는 받지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    const channel = await createChannel(ctx.app, a, 'general');
    const res = await req(ctx.app, 'POST', `/api/conversations/${channel}/messages`, a, {
      client_message_id: randomUUID(),
      body: '위장',
      author_kind: 'bot',
    });
    expect(res.statusCode).toBe(400);
  });
});
