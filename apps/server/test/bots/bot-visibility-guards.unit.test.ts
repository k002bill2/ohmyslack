import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildBotApp } from '../../src/modules/bots/listener.js';
import type { BotService } from '../../src/modules/bots/service.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import type { MessageRecord } from '../../src/modules/messages/store.js';
import type { MessagesService } from '../../src/modules/messages/service.js';
import type { SyncService } from '../../src/modules/sync/service.js';

/** 봇 가시성 가드(F-1·F-5)와 joined_seq 페이지 자르기(F-2·F-4) 라우트 배선. DB 없이 페이크 서비스 + inject. */
const BOT = '00000000-0000-4000-8000-000000000001';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const PORT = 4100;
const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer omsb_${'A'.repeat(43)}` };

function record(seq: number, threadRootId: string | null = null): MessageRecord {
  return {
    id: randomUUID(),
    conversationId: CONV,
    seq,
    authorId: BOT,
    authorKind: 'human',
    clientMessageId: randomUUID(),
    threadRootId,
    body: `m${seq}`,
    createdAt: new Date(0),
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: threadRootId === null ? 0 : null,
  };
}

interface Fixture {
  readonly visible: ReadonlySet<string>;
  readonly joined: number | undefined;
  readonly snapshot?: { messages: MessageRecord[]; hasMore: boolean };
  readonly history?: { messages: MessageRecord[]; hasMore: boolean };
}

function setup(f: Fixture) {
  const calls = { edit: 0, markRead: 0, history: [] as unknown[] };
  const bots = {
    verifyToken: async () => ({ botUserId: BOT, tokenId: 't' }),
    visibleMessageIds: async (_bot: string, ids: readonly string[]) => new Set(ids.filter((id) => f.visible.has(id))),
    joinedSeq: async () => f.joined,
  } as unknown as BotService;
  const conversations = { assertAccess: async () => ({}) } as unknown as ConversationsService;
  const messages = {
    resolveAccess: async () => ({}),
    edit: async () => {
      calls.edit += 1;
      throw new Error('edit은 가드 뒤에서만');
    },
    history: async (_conv: string, page: unknown) => {
      calls.history.push(page);
      return f.history ?? { messages: [], hasMore: false };
    },
  } as unknown as MessagesService;
  const sync = {
    snapshot: async () => ({ snapshotCursor: 9, ...(f.snapshot ?? { messages: [], hasMore: false }) }),
    markRead: async (_u: string, input: { conversationId: string; threadRootId: string | null; lastReadSeq: number }) => {
      calls.markRead += 1;
      return { ...input, updatedAt: new Date(0) };
    },
  } as unknown as SyncService;
  const app = buildBotApp({ bots, conversations, messages, sync, logger: { log: () => undefined }, port: PORT });
  return { app, calls };
}

describe('봇 가시성 가드 배선(F-1·F-5)', () => {
  it('FR-BOT-09 F-1 read-state의 thread_root_id가 안 보이면 404·저장 0, 보이면 저장, 루트 없음은 판정 없이 저장', async () => {
    const shown = randomUUID();
    const { app, calls } = setup({ visible: new Set([shown]), joined: 0 });
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/bot/v1/read-state', headers, payload: { conversation_id: CONV, last_read_seq: 3, ...payload } });
    const hidden = await put({ thread_root_id: randomUUID() });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('not_found');
    expect(calls.markRead).toBe(0);
    expect((await put({ thread_root_id: shown.toUpperCase() })).statusCode).toBe(200);
    expect((await put({})).statusCode).toBe(200);
    expect((await put({ thread_root_id: null })).statusCode).toBe(200);
    expect(calls.markRead).toBe(3);
    await app.close();
  });

  it('FR-BOT-09 F-5 안 보이는 메시지 PATCH는 404이고 수정 서비스를 부르지 않는다', async () => {
    const { app, calls } = setup({ visible: new Set(), joined: 0 });
    const res = await app.inject({ method: 'PATCH', url: `/api/bot/v1/messages/${randomUUID()}`, headers, payload: { body: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(calls.edit).toBe(0);
    await app.close();
  });
});

describe('봇 페이지 joined_seq 자르기 배선(F-2·F-4)', () => {
  it('FR-BOT-09 F-2 snapshot 다음 페이지가 전부 seq ≤ joined_seq면 has_more=false·next_before_seq=null', async () => {
    const a = record(11);
    const b = record(12);
    const url = `/api/bot/v1/sync/snapshot?conversation_id=${CONV}&limit=2`;
    const cut = setup({ visible: new Set([a.id, b.id]), joined: 10, snapshot: { messages: [a, b], hasMore: true } });
    expect((await cut.app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ has_more: false, next_before_seq: null });
    await cut.app.close();
    // 경계 위(joined_seq+1보다 큼)는 다음 페이지가 남는다.
    const more = setup({ visible: new Set([b.id]), joined: 5, snapshot: { messages: [a, b], hasMore: true } });
    const page = (await more.app.inject({ method: 'GET', url, headers })).json();
    expect(page).toMatchObject({ has_more: true, next_before_seq: 11 });
    expect(page.messages.map((m: { id: string }) => m.id)).toEqual([b.id]);
    await more.app.close();
    // 멤버십이 없으면 빈 마지막 페이지.
    const gone = setup({ visible: new Set([a.id]), joined: undefined, snapshot: { messages: [a], hasMore: true } });
    expect((await gone.app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ messages: [], has_more: false, next_before_seq: null });
    await gone.app.close();
  });

  it('FR-BOT-09 F-4 이력 after_seq < joined_seq면 joined_seq로 올려 한 번만 조회하고, 그 이상·형식 오류·멤버십 없음은 그대로', async () => {
    const a = record(21);
    const t = setup({ visible: new Set([a.id]), joined: 20, history: { messages: [a], hasMore: true } });
    const get = (q: string) => t.app.inject({ method: 'GET', url: `/api/bot/v1/conversations/${CONV}/messages${q}`, headers });
    const first = await get('?after_seq=0&limit=1');
    expect(first.json()).toMatchObject({ has_more: true });
    expect(t.calls.history).toEqual([{ limit: 1, afterSeq: 20 }]);
    await get('?after_seq=25&limit=1');
    expect(t.calls.history.at(-1)).toEqual({ limit: 1, afterSeq: 25 });
    expect((await get('?after_seq=-1')).statusCode).toBe(400);
    expect(t.calls.history).toHaveLength(2);
    await t.app.close();

    const empty = setup({ visible: new Set(), joined: undefined, history: { messages: [a], hasMore: true } });
    const res = await empty.app.inject({ method: 'GET', url: `/api/bot/v1/conversations/${CONV}/messages?after_seq=0`, headers });
    expect(res.json()).toEqual({ messages: [], has_more: false });
    expect(empty.calls.history).toEqual([{ limit: 100, afterSeq: 0 }]);
    await empty.app.close();
  });
});
