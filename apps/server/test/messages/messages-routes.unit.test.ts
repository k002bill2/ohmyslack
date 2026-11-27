import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { UserRecord } from '../../src/modules/auth/store.js';
import type { ConversationsStore } from '../../src/modules/conversations/store.js';
import type { MessageChange, MessageDeleted } from '../../src/modules/messages/events.js';
import type { MessageRecord, MessagesStore, NewMessage, PageRequest } from '../../src/modules/messages/store.js';
import { HISTORY_LIMIT_MAX, MESSAGE_BODY_MAX, messageWriteResponseSchema, type MessageView } from '../../src/shared.js';
import { createMetricsRecorder, type MetricDims, type MetricsRecorder } from '../../src/modules/ops/metrics.js';
import { createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp } from '../support/auth-app.js';

/** messages 라우트의 HTTP 분기(메모리 저장소). 실DB 트랜잭션·동시성·멱등은 int 테스트가 본다. */
const SECRET = ['correct', 'horse', 'battery', 'staple'].join(' ');
const T0 = new Date('2026-01-01T00:00:00.000Z');

interface MessagesFixture {
  readonly msgs: Map<string, MessageRecord>;
  readonly pages: PageRequest[];
  readonly store: MessagesStore;
}

/** 대화 멤버십을 공유하는 메모리 메시지 저장소. pg 구현과 같은 결과 kind를 돌려준다. */
function memoryMessages(members: Map<string, Set<string>>): MessagesFixture {
  const msgs = new Map<string, MessageRecord>();
  const pages: PageRequest[] = [];
  let seq = 0;
  let changeId = 0;
  const isMember = (c: string, u: string) => members.get(c)?.has(u) ?? false;
  const own = (id: string, actor: string) => {
    const m = msgs.get(id);
    if (m === undefined || m.deletedAt !== null || !isMember(m.conversationId, actor)) return 'not_found' as const;
    return m.authorId === actor ? m : ('forbidden' as const);
  };
  const save = (m: MessageRecord) => {
    msgs.set(m.id, m);
    changeId += 1;
    return { kind: 'ok' as const, message: m, changeId };
  };
  const page = (pred: (m: MessageRecord) => boolean, p: PageRequest) => {
    pages.push(p);
    const all = [...msgs.values()].filter(pred).sort((a, b) => a.seq - b.seq);
    return { messages: all.slice(0, p.limit), hasMore: all.length > p.limit };
  };
  const store: MessagesStore = {
    async locate(id) {
      const m = msgs.get(id);
      return m === undefined ? undefined : { conversationId: m.conversationId, authorId: m.authorId, threadRootId: m.threadRootId };
    },
    async send(n: NewMessage) {
      if (!members.has(n.conversationId)) return { kind: 'not_member' };
      const prior = [...msgs.values()].find((m) => m.conversationId === n.conversationId && m.authorId === n.authorId && m.clientMessageId === n.clientMessageId);
      if (prior !== undefined) {
        const same = prior.body === n.body && prior.threadRootId === n.threadRootId;
        return same ? { kind: 'replayed', message: prior, changeId: 1 } : { kind: 'conflict' };
      }
      if (!isMember(n.conversationId, n.authorId)) return { kind: 'not_member' };
      const root = n.threadRootId === null ? undefined : msgs.get(n.threadRootId);
      if (n.threadRootId !== null && (root === undefined || root.threadRootId !== null || root.deletedAt !== null)) return { kind: 'bad_root' };
      seq += 1;
      const message: MessageRecord = {
        id: n.id,
        conversationId: n.conversationId,
        seq,
        authorId: n.authorId,
        authorKind: 'human',
        clientMessageId: n.clientMessageId,
        threadRootId: n.threadRootId,
        body: n.body,
        createdAt: n.at,
        editedAt: null,
        deletedAt: null,
        mentionUserIds: [...n.mentionUserIds],
        rootReplyCount: n.threadRootId === null ? 0 : null,
      };
      const { changeId: id } = save(message);
      return { kind: 'created', message, changeId: id };
    },
    async edit(e) {
      const m = own(e.id, e.editorId);
      if (typeof m === 'string') return { kind: m };
      return save({ ...m, body: e.body, editedAt: e.at, mentionUserIds: [...e.mentionUserIds] });
    },
    async remove(id, actor, at) {
      const m = own(id, actor);
      if (typeof m === 'string') return { kind: m };
      return save({ ...m, body: null, deletedAt: at, mentionUserIds: [] });
    },
    async history(c, p) {
      return page((m) => m.conversationId === c && m.threadRootId === null, p);
    },
    async get(id) {
      return msgs.get(id);
    },
    async replies(r, p) {
      return page((m) => m.threadRootId === r, p);
    },
  };
  return { msgs, pages, store };
}

function memoryConversations(members: Map<string, Set<string>>): ConversationsStore {
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  return {
    async findAccess(id, userId) {
      const m = members.get(id);
      return m === undefined ? undefined : { kind: 'channel', activeMember: m.has(userId) };
    },
    createChannel: unused,
    discover: unused,
    join: unused,
    leave: unused,
    listMembers: unused,
    listForUser: unused,
    openDm: unused,
    addBot: unused,
    removeBot: unused,
    deleteChannel: unused,
  };
}

let storedHash: string;
beforeAll(async () => {
  storedHash = await hashPassword(SECRET);
});

interface Sess {
  readonly token: string;
  readonly csrf: string;
}

type App = ReturnType<typeof testApp>;

function user(id: string, email: string): UserRecord {
  return { id, emailNorm: email, displayName: email, kind: 'human', passwordHash: storedHash, status: 'active', role: 'member' };
}

async function signIn(app: App, email: string): Promise<Sess> {
  const res = await login(app, email, SECRET);
  return { token: sessionCookie(res) ?? '', csrf: res.json<{ csrf_token: string }>().csrf_token };
}

async function setup(metrics?: MetricsRecorder) {
  const auth = createMemoryAuthStore();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const eveId = randomUUID();
  for (const [id, email] of [
    [aliceId, 'alice@example.test'],
    [bobId, 'bob@example.test'],
    [eveId, 'eve@example.test'],
  ] as const)
    auth.users.set(id, user(id, email));
  const conv = randomUUID();
  const members = new Map([[conv, new Set([aliceId, bobId])]]);
  const fx = memoryMessages(members);
  const app = testApp({
    authStore: auth,
    conversationsStore: memoryConversations(members),
    messagesStore: fx.store,
    clock: () => T0.getTime(),
    ...(metrics === undefined ? {} : { metrics }),
  });
  const events = { created: [] as MessageChange[], updated: [] as MessageChange[], deleted: [] as MessageDeleted[] };
  app.messageEvents.on('created', (e) => events.created.push(e));
  app.messageEvents.on('updated', (e) => events.updated.push(e));
  app.messageEvents.on('deleted', (e) => events.deleted.push(e));
  const alice = await signIn(app, 'alice@example.test');
  const bob = await signIn(app, 'bob@example.test');
  const eve = await signIn(app, 'eve@example.test');
  return { app, fx, conv, members, events, aliceId, alice, bob, eve };
}

function call(app: App, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, s: Sess, payload?: object) {
  const headers = { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${s.token}`, 'x-csrf-token': s.csrf };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

const code = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

async function post(app: App, conv: string, s: Sess, body: object) {
  return call(app, 'POST', `/api/conversations/${conv}/messages`, s, { client_message_id: randomUUID(), body: 'hello', ...body });
}

async function sent(app: App, conv: string, s: Sess, body: object = {}): Promise<MessageView> {
  const res = await post(app, conv, s, body);
  expect(res.statusCode).toBe(201);
  return res.json<{ message: MessageView }>().message;
}

describe('messages 라우트: 전송', () => {
  it('새 메시지 201 + created 이벤트, 같은 키 같은 payload 재시도 200 + 이벤트 없음', async () => {
    const { app, conv, alice, aliceId, events, fx } = await setup();
    const key = randomUUID();
    const mention = randomUUID();
    const first = await post(app, conv, alice, { client_message_id: key, body: 'hi', mention_user_ids: [mention] });
    expect(first.statusCode).toBe(201);
    // 계약 고정: 201 본문은 웹이 읽는 shared 스키마 그대로여야 한다(DB 없는 단위 테스트에서도).
    const body = messageWriteResponseSchema.parse(first.json());
    expect(body.message).toMatchObject({
      conversation_id: conv,
      author_id: aliceId,
      client_message_id: key,
      thread_root_id: null,
      body: 'hi',
      created_at: T0.toISOString(),
      edited_at: null,
      deleted_at: null,
      root_reply_count: 0,
    });
    expect(body).toMatchObject({ seq: body.message.seq, change_id: 1, mention_user_ids: [mention] });
    expect(events.created).toHaveLength(1);
    const again = await post(app, conv, alice, { client_message_id: key, body: 'hi', mention_user_ids: [mention] });
    expect(again.statusCode).toBe(200);
    const replayed = messageWriteResponseSchema.parse(again.json());
    expect(replayed.message.id).toBe(body.message.id);
    expect(replayed).toMatchObject({ seq: body.seq, mention_user_ids: [mention] });
    expect(events.created).toHaveLength(1);
    expect(fx.msgs.size).toBe(1);
  });

  it('같은 키 다른 payload 409 idempotency_conflict, 이벤트 없음', async () => {
    const { app, conv, alice, events } = await setup();
    const key = randomUUID();
    await sent(app, conv, alice, { client_message_id: key, body: 'a' });
    const res = await post(app, conv, alice, { client_message_id: key, body: 'b' });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('idempotency_conflict');
    expect(events.created).toHaveLength(1);
  });

  it('잘못된 본문 400: 빈·공백, code point 상한 초과, 추가 키, 키 형식', async () => {
    const { app, conv, alice, events } = await setup();
    const bad = [
      { body: '' },
      { body: '   ' },
      { body: 'a'.repeat(MESSAGE_BODY_MAX + 1) },
      { body: '😀'.repeat(MESSAGE_BODY_MAX + 1) },
      { extra: 1 },
      { client_message_id: 'nope' },
      { mention_user_ids: ['nope'] },
    ];
    for (const b of bad) {
      const res = await post(app, conv, alice, b);
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe('invalid_request');
    }
    expect((await post(app, conv, alice, { body: '😀'.repeat(MESSAGE_BODY_MAX) })).statusCode).toBe(201);
    expect(events.created).toHaveLength(1);
  });

  it('잘못된 스레드 원문 400 invalid_thread_root: 없는 원문, 답글을 원문으로', async () => {
    const { app, conv, alice } = await setup();
    const missing = await post(app, conv, alice, { thread_root_id: randomUUID() });
    expect(missing.statusCode).toBe(400);
    expect(code(missing)).toBe('invalid_thread_root');
    const root = await sent(app, conv, alice);
    const reply = await sent(app, conv, alice, { thread_root_id: root.id });
    expect(reply.root_reply_count).toBeNull();
    expect((await post(app, conv, alice, { thread_root_id: reply.id })).statusCode).toBe(400);
  });

  it('비참여자·없는 대화·형식 오류 대화 id는 404, 저장소까지 가지 않는다', async () => {
    const { app, conv, eve, fx } = await setup();
    expect((await post(app, conv, eve, {})).statusCode).toBe(404);
    expect((await post(app, randomUUID(), eve, {})).statusCode).toBe(404);
    expect((await post(app, 'not-a-uuid', eve, {})).statusCode).toBe(404);
    expect(fx.msgs.size).toBe(0);
  });
});

describe('messages 라우트: 수정·삭제', () => {
  it('PATCH: 작성자 200 + updated 이벤트, 다른 멤버 403, 비참여자·없는 id·형식 오류 404, 잘못된 본문 400', async () => {
    const { app, conv, alice, bob, eve, events } = await setup();
    const m = await sent(app, conv, alice);
    const mention = randomUUID();
    const res = await call(app, 'PATCH', `/api/messages/${m.id}`, alice, { body: 'edited', mention_user_ids: [mention] });
    expect(res.statusCode).toBe(200);
    expect(messageWriteResponseSchema.parse(res.json())).toMatchObject({ message: { id: m.id, body: 'edited', edited_at: T0.toISOString() }, mention_user_ids: [mention] });
    expect(events.updated).toHaveLength(1);
    const noMentions = await call(app, 'PATCH', `/api/messages/${m.id}`, alice, { body: 'again' });
    expect(messageWriteResponseSchema.parse(noMentions.json()).mention_user_ids).toEqual([]);
    const forbidden = await call(app, 'PATCH', `/api/messages/${m.id}`, bob, { body: 'x' });
    expect(forbidden.statusCode).toBe(403);
    expect(code(forbidden)).toBe('forbidden');
    expect((await call(app, 'PATCH', `/api/messages/${m.id}`, eve, { body: 'x' })).statusCode).toBe(404);
    expect((await call(app, 'PATCH', `/api/messages/${randomUUID()}`, alice, { body: 'x' })).statusCode).toBe(404);
    expect((await call(app, 'PATCH', '/api/messages/not-a-uuid', alice, { body: 'x' })).statusCode).toBe(404);
    expect((await call(app, 'PATCH', `/api/messages/${m.id}`, alice, { body: ' ' })).statusCode).toBe(400);
    expect((await call(app, 'PATCH', `/api/messages/${m.id}`, alice, { body: 'x', extra: 1 })).statusCode).toBe(400);
    expect(events.updated).toHaveLength(2);
  });

  it('DELETE: 다른 멤버 403(이벤트 없음), 작성자 200 tombstone + deleted 이벤트, 두 번째 삭제·삭제 후 수정 404', async () => {
    const { app, conv, alice, bob, events, fx } = await setup();
    const m = await sent(app, conv, alice);
    expect((await call(app, 'DELETE', `/api/messages/${m.id}`, bob)).statusCode).toBe(403);
    expect(events.deleted).toHaveLength(0);
    const res = await call(app, 'DELETE', `/api/messages/${m.id}`, alice);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message_id: m.id, seq: m.seq, deleted_at: T0.toISOString(), change_id: 2 });
    expect(events.deleted).toEqual([{ changeId: 2, conversationId: conv, messageId: m.id, seq: m.seq, deletedAt: T0 }]);
    expect(fx.msgs.get(m.id)?.body).toBeNull();
    expect((await call(app, 'DELETE', `/api/messages/${m.id}`, alice)).statusCode).toBe(404);
    expect((await call(app, 'PATCH', `/api/messages/${m.id}`, alice, { body: 'x' })).statusCode).toBe(404);
    expect((await call(app, 'DELETE', '/api/messages/not-a-uuid', alice)).statusCode).toBe(404);
    expect(events.deleted).toHaveLength(1);
  });
});

describe('messages 라우트: 이력·답글', () => {
  it('GET 이력: 원문만, limit 기본값 HISTORY_LIMIT_MAX, 커서 하나만 전달, has_more', async () => {
    const { app, conv, alice, bob, fx } = await setup();
    const root = await sent(app, conv, alice);
    await sent(app, conv, bob, { thread_root_id: root.id });
    await sent(app, conv, bob);
    const all = await call(app, 'GET', `/api/conversations/${conv}/messages`, alice);
    expect(all.statusCode).toBe(200);
    const page = all.json<{ messages: MessageView[]; has_more: boolean }>();
    expect(page.messages.every((m) => m.thread_root_id === null)).toBe(true);
    expect(page).toMatchObject({ has_more: false });
    expect(page.messages).toHaveLength(2);
    expect(fx.pages[0]).toEqual({ limit: HISTORY_LIMIT_MAX });
    const one = await call(app, 'GET', `/api/conversations/${conv}/messages?limit=1&roots_only=true`, alice);
    expect(one.json<{ has_more: boolean }>().has_more).toBe(true);
    for (const q of ['before_seq=5', 'after_seq=1', 'around_seq=2']) await call(app, 'GET', `/api/conversations/${conv}/messages?${q}`, alice);
    expect(fx.pages.slice(2)).toEqual([
      { limit: HISTORY_LIMIT_MAX, beforeSeq: 5 },
      { limit: HISTORY_LIMIT_MAX, afterSeq: 1 },
      { limit: HISTORY_LIMIT_MAX, aroundSeq: 2 },
    ]);
  });

  it('GET 이력 query 검증 400(두 커서·상한 초과·음수·알 수 없는 키), 비참여자 404', async () => {
    const { app, conv, alice, eve, fx } = await setup();
    const bad = ['before_seq=1&after_seq=2', 'after_seq=1&around_seq=2', `limit=${HISTORY_LIMIT_MAX + 1}`, 'limit=0', 'before_seq=-1', 'x=1', 'roots_only=yes'];
    for (const q of bad) expect((await call(app, 'GET', `/api/conversations/${conv}/messages?${q}`, alice)).statusCode).toBe(400);
    expect((await call(app, 'GET', `/api/conversations/${conv}/messages`, eve)).statusCode).toBe(404);
    expect(fx.pages).toHaveLength(0);
  });

  it('GET 답글: root + 답글, 답글의 답글 400, 없는 id·형식 오류·비참여자 404, query 검증 400', async () => {
    const { app, conv, alice, bob, eve, fx } = await setup();
    const root = await sent(app, conv, alice);
    const reply = await sent(app, conv, bob, { thread_root_id: root.id });
    const res = await call(app, 'GET', `/api/messages/${root.id}/replies?limit=10`, bob);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ root: { id: root.id }, replies: [{ id: reply.id, thread_root_id: root.id }], has_more: false });
    expect(fx.pages).toEqual([{ limit: 10 }]);
    const nested = await call(app, 'GET', `/api/messages/${reply.id}/replies`, alice);
    expect(nested.statusCode).toBe(400);
    expect(code(nested)).toBe('invalid_thread_root');
    expect((await call(app, 'GET', `/api/messages/${randomUUID()}/replies`, alice)).statusCode).toBe(404);
    expect((await call(app, 'GET', '/api/messages/not-a-uuid/replies', alice)).statusCode).toBe(404);
    expect((await call(app, 'GET', `/api/messages/${root.id}/replies`, eve)).statusCode).toBe(404);
    expect((await call(app, 'GET', `/api/messages/${root.id}/replies?before_seq=1&after_seq=2`, alice)).statusCode).toBe(400);
    expect((await call(app, 'GET', `/api/messages/${root.id}/replies?around_seq=1`, alice)).statusCode).toBe(400);
    expect(fx.pages).toHaveLength(1);
  });

  it('메시지 라우트는 모두 access 메타와 함께 등록된다', async () => {
    const { app } = await setup();
    const urls = app.accessRoutes.filter((r) => r.url.includes('messages')).map((r) => `${r.method} ${r.url}`);
    expect(urls).toEqual(
      expect.arrayContaining([
        'POST /api/conversations/:id/messages',
        'GET /api/conversations/:id/messages',
        'GET /api/messages/:id/replies',
        'GET /api/messages/:id/preview',
        'PATCH /api/messages/:id',
        'DELETE /api/messages/:id',
      ]),
    );
  });
});

describe('messages 라우트: message_send_result 계측(PRD §10)', () => {
  function capture() {
    const rows: MetricDims[] = [];
    const metrics = createMetricsRecorder({
      store: {
        async add(_day, event, dims, n) {
          if (event === 'message_send_result') rows.push({ ...dims, n });
        },
        pruneBefore: async () => 0,
      },
      clock: () => T0.getTime(),
    });
    return { metrics, rows };
  }

  async function sends(metrics?: MetricsRecorder) {
    const t = await setup(metrics);
    const url = `/api/conversations/${t.conv}/messages`;
    const key = randomUUID();
    const first = await call(t.app, 'POST', url, t.alice, { client_message_id: key, body: 'OMS-CANARY-BODY-6f1c2a' });
    const rootId = first.json<{ message: MessageView }>().message.id;
    const results = [
      first,
      await call(t.app, 'POST', url, t.alice, { client_message_id: key, body: 'OMS-CANARY-BODY-6f1c2a' }),
      await call(t.app, 'POST', url, t.alice, { client_message_id: key, body: 'other' }),
      await call(t.app, 'POST', url, t.alice, { client_message_id: randomUUID(), body: 'reply', thread_root_id: rootId }),
      await call(t.app, 'POST', url, t.alice, { client_message_id: randomUUID(), body: '' }),
      await call(t.app, 'POST', url, t.eve, { client_message_id: randomUUID(), body: 'x' }),
    ];
    await t.app.close();
    return results.map((r) => ({ status: r.statusCode, code: r.statusCode >= 400 ? code(r) : 'ok' }));
  }

  it('201 ok·200 duplicate·409/400 rejected, conv_kind·has_thread·duration 버킷, 가드 전 거부(비참여자 404)는 기록 없음', async () => {
    const { metrics, rows } = capture();
    await sends(metrics);
    await metrics.idle();
    const base = { conv_kind: 'channel', duration_ms: 0 };
    expect(rows).toEqual([
      { ...base, outcome: 'ok', has_thread: false, n: 1 },
      { ...base, outcome: 'duplicate', has_thread: false, n: 1 },
      // 409·400 거부는 같은 dims라 메모리에서 한 행(+2)으로 합산된다.
      { ...base, outcome: 'rejected', has_thread: false, n: 2 },
      { ...base, outcome: 'ok', has_thread: true, n: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toContain('OMS-CANARY');
  });

  it('계측 기록기가 throw해도 전송 응답 상태·오류 code는 계측 없을 때와 같다', async () => {
    const throwing: MetricsRecorder = {
      record() {
        throw new Error('metrics down');
      },
    };
    const baseline = await sends();
    expect(await sends(throwing)).toEqual(baseline);
    expect(baseline.map((r) => r.status)).toEqual([201, 200, 409, 201, 400, 404]);
  });
});
