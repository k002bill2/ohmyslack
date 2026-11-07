import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { UserRecord } from '../../src/modules/auth/store.js';
import type { ConversationsStore } from '../../src/modules/conversations/store.js';
import type { MessageRecord, MessagesStore } from '../../src/modules/messages/store.js';
import type { ReadUpdated } from '../../src/modules/sync/events.js';
import type { ReadTarget, ScanRequest, SyncStore } from '../../src/modules/sync/store.js';
import { readStateResponseSchema, snapshotResponseSchema, syncResponseSchema } from '../../src/shared.js';
import { createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp } from '../support/auth-app.js';

/** sync·snapshot·read-state 라우트의 입력 검증·접근 가드·응답 매핑(메모리 저장소). 실제 SQL은 int 테스트가 본다. */
const SECRET = ['correct', 'horse', 'battery', 'staple'].join(' ');
const T0 = new Date('2026-01-01T00:00:00.000Z');

let storedHash: string;
beforeAll(async () => {
  storedHash = await hashPassword(SECRET);
});

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function record(conversationId: string, seq: number): MessageRecord {
  return {
    id: randomUUID(),
    conversationId,
    seq,
    authorId: randomUUID(),
    clientMessageId: randomUUID(),
    threadRootId: null,
    body: `m${seq}`,
    createdAt: T0,
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: 0,
  };
}

interface Calls {
  readonly scans: ScanRequest[];
  readonly snapshots: [string, number | undefined, number][];
  readonly merges: ReadTarget[];
}

async function setup() {
  const auth = createMemoryAuthStore();
  const aliceId = randomUUID();
  const eveId = randomUUID();
  const user = (id: string, email: string): UserRecord => ({
    id,
    emailNorm: email,
    displayName: email,
    passwordHash: storedHash,
    status: 'active',
    role: 'member',
  });
  auth.users.set(aliceId, user(aliceId, 'alice@example.test'));
  auth.users.set(eveId, user(eveId, 'eve@example.test'));
  const conv = randomUUID();
  const members = new Map<string, Set<string>>([[conv, new Set([aliceId])]]);
  const conversationsStore: ConversationsStore = {
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
  };
  const messagesStore: MessagesStore = {
    locate: unused,
    send: unused,
    edit: unused,
    remove: unused,
    history: unused,
    get: unused,
    replies: unused,
  };
  const calls: Calls = { scans: [], snapshots: [], merges: [] };
  const msgs = [record(conv, 4), record(conv, 5)];
  const syncStore: SyncStore = {
    watermark: async () => 50,
    retentionFloor: async () => 0,
    async scan(r) {
      calls.scans.push(r);
      return { scannedThrough: 30, changes: [{ changeId: 12, message: msgs[0] as MessageRecord }] };
    },
    async snapshot(c, before, limit) {
      calls.snapshots.push([c, before, limit]);
      return { messages: msgs, hasMore: before === undefined };
    },
    async mergeRead(t) {
      calls.merges.push(t);
      return t.lastReadSeq > 100 ? { ok: false } : { ok: true, lastReadSeq: t.lastReadSeq, updatedAt: T0 };
    },
  };
  const app = testApp({ authStore: auth, conversationsStore, messagesStore, syncStore, clock: () => T0.getTime() });
  const reads: ReadUpdated[] = [];
  app.readEvents.onUpdated((e) => reads.push(e));
  const signIn = async (email: string) => {
    const res = await login(app, email, SECRET);
    return { token: sessionCookie(res) ?? '', csrf: res.json<{ csrf_token: string }>().csrf_token };
  };
  const alice = await signIn('alice@example.test');
  const eve = await signIn('eve@example.test');
  const call = (method: 'GET' | 'PUT', url: string, s: { token: string; csrf: string }, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${s.token}`, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload }),
    });
  return { app, conv, aliceId, alice, eve, calls, msgs, reads, call };
}

const code = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

describe('GET /api/sync', () => {
  it('페이지를 응답 스키마로 매핑하고 has_more·next_cursor를 scannedThrough로 채운다', async () => {
    const { conv, aliceId, alice, calls, msgs, call } = await setup();
    const res = await call('GET', '/api/sync?after=10&limit=20', alice);
    expect(res.statusCode).toBe(200);
    const body = syncResponseSchema.parse(res.json());
    expect(body).toMatchObject({ through_cursor: 50, scanned_through: 30, has_more: true, next_cursor: 30 });
    expect(body.changes).toEqual([expect.objectContaining({ change_id: 12, conversation_id: conv, message: expect.objectContaining({ id: msgs[0]?.id }) })]);
    expect(calls.scans).toEqual([{ userId: aliceId, after: 10, through: 50, limit: 20 }]);
  });

  it.each(['/api/sync', '/api/sync?after=-1', '/api/sync?after=5&through=4', '/api/sync?after=1&extra=1'])(
    '잘못된 query %s → 400 invalid_request',
    async (url) => {
      const { alice, calls, call } = await setup();
      const res = await call('GET', url, alice);
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe('invalid_request');
      expect(calls.scans).toEqual([]);
    },
  );
});

describe('GET /api/sync/snapshot', () => {
  it('멤버는 snapshot을 받고 has_more면 next_before_seq는 첫 메시지 seq', async () => {
    const { conv, alice, calls, call } = await setup();
    const res = await call('GET', `/api/sync/snapshot?conversation_id=${conv}`, alice);
    expect(res.statusCode).toBe(200);
    const body = snapshotResponseSchema.parse(res.json());
    expect(body).toMatchObject({ snapshot_cursor: 50, conversation_id: conv, has_more: true, next_before_seq: 4 });
    expect(body.messages.map((m) => m.seq)).toEqual([4, 5]);

    const last = snapshotResponseSchema.parse((await call('GET', `/api/sync/snapshot?conversation_id=${conv}&before_seq=4&limit=2`, alice)).json());
    expect(last).toMatchObject({ has_more: false, next_before_seq: null });
    expect(calls.snapshots).toEqual([
      [conv, undefined, 100],
      [conv, 4, 2],
    ]);
  });

  it('비멤버·없는 대화는 404, conversation_id 형식 오류는 400', async () => {
    const { conv, eve, alice, calls, call } = await setup();
    const hidden = await call('GET', `/api/sync/snapshot?conversation_id=${conv}`, eve);
    expect([hidden.statusCode, code(hidden)]).toEqual([404, 'not_found']);
    const missing = await call('GET', `/api/sync/snapshot?conversation_id=${randomUUID()}`, alice);
    expect(missing.statusCode).toBe(404);
    const bad = await call('GET', '/api/sync/snapshot?conversation_id=nope', alice);
    expect([bad.statusCode, code(bad)]).toEqual([400, 'invalid_request']);
    const badLimit = await call('GET', `/api/sync/snapshot?conversation_id=${conv}&limit=0`, alice);
    expect(badLimit.statusCode).toBe(400);
    expect(calls.snapshots).toEqual([]);
  });
});

describe('PUT /api/read-state', () => {
  it('병합 결과를 돌려주고 read 이벤트를 발행한다(thread_root_id 생략 → null)', async () => {
    const { conv, aliceId, alice, calls, reads, call } = await setup();
    const res = await call('PUT', '/api/read-state', alice, { conversation_id: conv, last_read_seq: 7 });
    expect(res.statusCode).toBe(200);
    expect(readStateResponseSchema.parse(res.json())).toEqual({
      conversation_id: conv,
      thread_root_id: null,
      last_read_seq: 7,
      updated_at: T0.toISOString(),
    });
    expect(calls.merges).toEqual([{ userId: aliceId, conversationId: conv, threadRootId: null, lastReadSeq: 7, at: T0 }]);
    expect(reads).toEqual([{ userId: aliceId, conversationId: conv, threadRootId: null, lastReadSeq: 7, updatedAt: T0 }]);
  });

  it('범위 밖 위치는 400, 비멤버는 404, 본문 형식 오류는 400 — 모두 이벤트 없음', async () => {
    const { conv, alice, eve, reads, calls, call } = await setup();
    const out = await call('PUT', '/api/read-state', alice, { conversation_id: conv, last_read_seq: 101 });
    expect([out.statusCode, code(out)]).toEqual([400, 'invalid_request']);
    const hidden = await call('PUT', '/api/read-state', eve, { conversation_id: conv, last_read_seq: 1 });
    expect(hidden.statusCode).toBe(404);
    const bad = await call('PUT', '/api/read-state', alice, { conversation_id: conv, last_read_seq: 'x' });
    expect([bad.statusCode, code(bad)]).toEqual([400, 'invalid_request']);
    expect(calls.merges).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  it('쿠키 없이 호출하면 401', async () => {
    const { app, conv } = await setup();
    const res = await app.inject({ method: 'PUT', url: '/api/read-state', headers: { host: HOST, origin: ORIGIN }, payload: { conversation_id: conv, last_read_seq: 1 } });
    expect(res.statusCode).toBe(401);
  });
});
