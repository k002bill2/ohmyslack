import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthEvents } from '../../src/modules/auth/events.js';
import type { Authenticated, AuthService } from '../../src/modules/auth/service.js';
import { createConversationEvents } from '../../src/modules/conversations/events.js';
import { createConversationsService } from '../../src/modules/conversations/service.js';
import type { ConversationsStore } from '../../src/modules/conversations/store.js';
import { createMessageEvents } from '../../src/modules/messages/events.js';
import type { MessageRecord } from '../../src/modules/messages/store.js';
import { createHub, type Hub, type HubSocket } from '../../src/modules/realtime/hub.js';
import { createReadEvents } from '../../src/modules/sync/events.js';
import type { FoldedChange, ScanRequest, ScanResult, SyncStore } from '../../src/modules/sync/store.js';
import { wsServerFrameSchema, type WsServerFrame } from '../../src/shared.js';

/** 허브의 구독·replay·팬아웃·재확인·만료 분기(메모리 가짜). 실제 소켓·DB 경로는 int 테스트가 본다. */
const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;
const C1 = randomUUID();
const C2 = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();

type Conn = ReturnType<Hub['attach']>;

interface FakeSocket extends HubSocket {
  readonly sent: WsServerFrame[];
  readonly closes: { code: number | undefined; reason: string | undefined }[];
}

function fakeSocket(): FakeSocket {
  const sent: WsServerFrame[] = [];
  const closes: { code: number | undefined; reason: string | undefined }[] = [];
  return {
    sent,
    closes,
    send: (data) => sent.push(wsServerFrameSchema.parse(JSON.parse(data))),
    close: (code, reason) => closes.push({ code, reason }),
  };
}

function record(conversationId: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: randomUUID(),
    conversationId,
    seq: 1,
    authorId: ALICE,
    authorKind: 'human',
    clientMessageId: randomUUID(),
    threadRootId: null,
    body: 'hi',
    createdAt: new Date(T0),
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: 0,
    ...over,
  };
}

function authed(userId: string, sessionId: string, token: string, expiresAt: number): Authenticated {
  return {
    token,
    user: { id: userId, emailNorm: `${userId}@x.test`, displayName: 'u', kind: 'human', passwordHash: 'h', status: 'active', role: 'member' },
    session: { id: sessionId, userId, tokenHash: 'th', createdAt: new Date(T0), lastSeenAt: new Date(T0), expiresAt: new Date(expiresAt), revokedAt: null },
  };
}

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

interface State {
  /** token → peek 결과. 없으면 세션 종료로 본다. */
  readonly sessions: Map<string, Authenticated>;
  /** `${conversationId}:${userId}` */
  readonly members: Set<string>;
  readonly changes: FoldedChange[];
  watermark: number;
  floor: number;
  pageSize: number;
  peekError: Error | undefined;
  /** 주어지면 watermark가 이 promise를 기다린다(replay 도중 live 도착 재현). */
  watermarkGate: Promise<void> | undefined;
  scanImpl: ((r: ScanRequest) => Promise<ScanResult>) | undefined;
  readonly scans: ScanRequest[];
  watermarkCalls: number;
  peekCalls: number;
}

let hub: Hub | undefined;

afterEach(() => {
  hub?.dispose();
  hub = undefined;
  vi.useRealTimers();
});

function setup(clock: () => number = () => T0) {
  const st: State = {
    sessions: new Map(),
    members: new Set(),
    changes: [],
    watermark: 10,
    floor: 0,
    pageSize: 500,
    peekError: undefined,
    watermarkGate: undefined,
    scanImpl: undefined,
    scans: [],
    watermarkCalls: 0,
    peekCalls: 0,
  };
  const auth: AuthService = {
    login: unused,
    issueSession: unused,
    authenticate: unused,
    async peek(token) {
      st.peekCalls += 1;
      if (st.peekError !== undefined) throw st.peekError;
      return token === undefined ? undefined : st.sessions.get(token);
    },
    logout: unused,
    revokeByToken: unused,
    listSessions: unused,
  };
  // 실제 접근 판정(assertAccess)에 멤버십만 메모리로 주입한다.
  const conversationStore: ConversationsStore = {
    async findAccess(conversationId, userId) {
      return { kind: 'channel', activeMember: st.members.has(`${conversationId}:${userId}`) };
    },
    createChannel: unused,
    discover: unused,
    join: unused,
    leave: unused,
    listMembers: unused,
    listForUser: unused,
    openDm: unused,
  };
  const syncStore: SyncStore = {
    async watermark() {
      st.watermarkCalls += 1;
      if (st.watermarkGate !== undefined) await st.watermarkGate;
      return st.watermark;
    },
    async retentionFloor() {
      return st.floor;
    },
    async scan(r) {
      st.scans.push(r);
      if (st.scanImpl !== undefined) return st.scanImpl(r);
      const rows = st.changes.filter((c) => c.changeId > r.after && c.changeId <= r.through).sort((a, b) => a.changeId - b.changeId);
      const page = rows.slice(0, st.pageSize);
      const scannedThrough = page.length < st.pageSize ? r.through : (page.at(-1)?.changeId ?? r.through);
      // 의도적으로 역순: 허브가 change_id 순으로 다시 정렬해야 한다.
      return { scannedThrough, changes: [...page].reverse() };
    },
    snapshot: unused,
    mergeRead: unused,
  };
  const events = {
    authEvents: createAuthEvents(),
    conversationEvents: createConversationEvents(),
    messageEvents: createMessageEvents(),
    readEvents: createReadEvents(),
  };
  const conversations = createConversationsService({ store: conversationStore, events: events.conversationEvents, clock });
  hub = createHub({ auth, conversations, syncStore, clock, ...events });
  const h = hub;

  const connect = (userId: string, opts: { expiresAt?: number } = {}) => {
    const sessionId = randomUUID();
    const token = randomUUID();
    const expiresAt = opts.expiresAt ?? T0 + HOUR;
    st.sessions.set(token, authed(userId, sessionId, token, expiresAt));
    const socket = fakeSocket();
    const conn = h.attach(socket, { userId, sessionId, token, expiresAt: new Date(expiresAt) });
    return { socket, conn, sessionId, token };
  };
  const join = (conversationId: string, userId: string) => st.members.add(`${conversationId}:${userId}`);
  return { st, hub: h, connect, join, ...events };
}

const flush = async (conn: Conn): Promise<void> => {
  await conn.queue;
  await conn.queue;
};

const types = (s: FakeSocket) => s.sent.map((f) => f.type);

describe('subscribe', () => {
  it('비멤버는 error not_found만 받고 구독되지 않는다', async () => {
    const t = setup();
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 0);
    await flush(a.conn);
    expect(a.socket.sent).toEqual([{ type: 'error', code: 'not_found', retryable: false, conversation_id: C1 }]);
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toHaveLength(1);
    expect(t.st.watermarkCalls).toBe(0);
  });

  it('(after, through] 구간에서 이 대화의 변경만 change_id 순으로 재생한 뒤 subscribed ACK를 보낸다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    const created = record(C1, { seq: 1 });
    const edited = record(C1, { seq: 2, editedAt: new Date(T0 + 1) });
    const deleted = record(C1, { seq: 3, body: null, deletedAt: new Date(T0 + 2) });
    t.st.changes.push(
      { changeId: 2, message: record(C1) }, // after 이하: 재생 제외
      { changeId: 4, message: created },
      { changeId: 5, message: record(C2) }, // 다른 대화: 제외
      { changeId: 7, message: edited },
      { changeId: 9, message: deleted },
      { changeId: 11, message: record(C1) }, // watermark 초과: 제외
    );
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 3);
    await flush(a.conn);
    expect(a.socket.sent).toEqual([
      expect.objectContaining({ type: 'message.created', conversation_id: C1, change_id: 4, message: expect.objectContaining({ id: created.id }) }),
      expect.objectContaining({ type: 'message.updated', change_id: 7, message: expect.objectContaining({ id: edited.id, edited_at: new Date(T0 + 1).toISOString() }) }),
      {
        type: 'message.deleted',
        conversation_id: C1,
        change_id: 9,
        message_id: deleted.id,
        seq: 3,
        deleted_at: new Date(T0 + 2).toISOString(),
      },
      { type: 'conversation.subscribed', conversation_id: C1, through_cursor: 10 },
    ]);
    expect(t.st.scans).toEqual([{ userId: ALICE, after: 3, through: 10, limit: 500 }]);
  });

  it('여러 페이지를 scannedThrough로 이어 스캔한다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.st.pageSize = 2;
    for (const id of [1, 2, 3, 4, 5]) t.st.changes.push({ changeId: id, message: record(C1, { seq: id }) });
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 0);
    await flush(a.conn);
    expect(a.socket.sent.map((f) => ('change_id' in f ? f.change_id : f.type))).toEqual([1, 2, 3, 4, 5, 'conversation.subscribed']);
    expect(t.st.scans.map((s) => s.after)).toEqual([0, 2, 4]);
  });

  it('스캔이 진전하지 않으면(scannedThrough <= cursor) 루프를 끝내고 ACK한다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.st.scanImpl = async (r) => ({ scannedThrough: r.after, changes: [] });
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 5);
    await flush(a.conn);
    expect(t.st.scans).toHaveLength(1);
    expect(a.socket.sent).toEqual([{ type: 'conversation.subscribed', conversation_id: C1, through_cursor: 10 }]);
  });

  it('after == watermark면 스캔 없이 바로 ACK한다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 10);
    await flush(a.conn);
    expect(t.st.scans).toHaveLength(0);
    expect(types(a.socket)).toEqual(['conversation.subscribed']);
  });

  it.each([
    ['watermark보다 큰 cursor', 11, 0],
    ['보존 경계보다 작은 cursor', 2, 3],
  ])('%s → cursor_expired + sync.required, 구독 없음', async (_name, after, floor) => {
    const t = setup();
    t.join(C1, ALICE);
    t.st.floor = floor;
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, after);
    await flush(a.conn);
    expect(a.socket.sent).toEqual([
      { type: 'error', code: 'cursor_expired', retryable: false, conversation_id: C1 },
      { type: 'sync.required' },
    ]);
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toHaveLength(2);
  });

  it('세션이 끝났으면 1008로 닫고 아무것도 보내지 않는다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    const a = t.connect(ALICE);
    t.st.sessions.delete(a.token);
    t.hub.subscribe(a.conn, C1, 0);
    await flush(a.conn);
    expect(a.socket.sent).toEqual([]);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
    expect(t.hub.size()).toBe(0);
  });

  it('처리 중 예외(scan reject)는 sync.required로 알린다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.st.scanImpl = async () => {
      throw new Error('db down');
    };
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 0);
    await flush(a.conn);
    expect(a.socket.sent).toEqual([{ type: 'sync.required' }]);
    expect(a.socket.closes).toEqual([]);
  });

  it('peek 자체가 reject되어도 sync.required로 알린다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    const a = t.connect(ALICE);
    await flush(a.conn); // attach 직후 세션 재확인을 먼저 끝낸다
    t.st.peekError = new Error('db down');
    t.hub.subscribe(a.conn, C1, 0);
    await flush(a.conn);
    expect(a.socket.sent).toEqual([{ type: 'sync.required' }]);
  });
});

describe('live fanout', () => {
  async function subscribed(t: ReturnType<typeof setup>, userId = ALICE) {
    t.join(C1, userId);
    const c = t.connect(userId);
    t.hub.subscribe(c.conn, C1, 10);
    await flush(c.conn);
    c.socket.sent.length = 0;
    return c;
  }

  it('구독 후 created/updated/deleted를 한 번씩 전달하고 through 이하·다른 대화는 보내지 않는다', async () => {
    const t = setup();
    const a = await subscribed(t);
    const m = record(C1);
    t.messageEvents.created({ changeId: 10, message: m }); // replay 경계 이하
    t.messageEvents.created({ changeId: 11, message: m });
    t.messageEvents.created({ changeId: 12, message: record(C2) });
    t.messageEvents.updated({ changeId: 13, message: { ...m, editedAt: new Date(T0 + 5) } });
    t.messageEvents.deleted({ changeId: 14, conversationId: C1, messageId: m.id, seq: m.seq, deletedAt: new Date(T0 + 6) });
    await flush(a.conn);
    expect(a.socket.sent.map((f) => [f.type, 'change_id' in f ? f.change_id : null])).toEqual([
      ['message.created', 11],
      ['message.updated', 13],
      ['message.deleted', 14],
    ]);
  });

  it('replay 도중 도착한 live는 ACK 뒤에 전달되고, through 이하 live는 중복 전달되지 않는다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.st.changes.push({ changeId: 8, message: record(C1) });
    let open!: () => void;
    t.st.watermarkGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 5);
    await vi.waitFor(() => expect(t.st.watermarkCalls).toBe(1));
    t.messageEvents.created({ changeId: 9, message: record(C1) }); // replay 경계(10) 이하 → 버린다
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    expect(a.socket.sent).toEqual([]);
    open();
    await flush(a.conn);
    expect(a.socket.sent.map((f) => [f.type, 'change_id' in f ? f.change_id : null])).toEqual([
      ['message.created', 8],
      ['conversation.subscribed', null],
      ['message.created', 11],
    ]);
  });

  it('전달 직전 멤버십이 끝났으면 메시지 대신 error not_found를 보내고 구독을 닫는다', async () => {
    const t = setup();
    const a = await subscribed(t);
    t.st.members.delete(`${C1}:${ALICE}`);
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toEqual([{ type: 'error', code: 'not_found', retryable: false, conversation_id: C1 }]);
    t.st.members.add(`${C1}:${ALICE}`);
    t.messageEvents.created({ changeId: 12, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toHaveLength(1);
  });

  it('전달 직전 세션이 없으면 1008로 닫고 보내지 않는다', async () => {
    const t = setup();
    const a = await subscribed(t);
    t.st.sessions.delete(a.token);
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toEqual([]);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
  });

  it('토큰이 다른 세션으로 해석되면(회전) 1008로 닫고 보내지 않는다', async () => {
    const t = setup();
    const a = await subscribed(t);
    t.st.sessions.set(a.token, authed(ALICE, randomUUID(), a.token, T0 + HOUR));
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toEqual([]);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
  });

  it('unsubscribe 뒤에는 live를 받지 않는다', async () => {
    const t = setup();
    const a = await subscribed(t);
    t.hub.unsubscribe(a.conn, C1);
    await flush(a.conn);
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    expect(a.socket.sent).toEqual([]);
  });
});

describe('도메인 이벤트', () => {
  it('onSessionRevoked는 해당 세션의 연결만 1008로 닫는다', async () => {
    const t = setup();
    const a = t.connect(ALICE);
    const b = t.connect(ALICE);
    expect(t.hub.size()).toBe(2);
    t.authEvents.sessionRevoked([a.sessionId, randomUUID()]);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_revoked' }]);
    expect(b.socket.closes).toEqual([]);
    expect(t.hub.size()).toBe(1);
    t.hub.sendError(a.conn, 'unavailable', true);
    expect(a.socket.sent).toEqual([]);
  });

  it('onMembershipEnded는 그 사용자의 구독만 끝낸다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.join(C1, BOB);
    const a = t.connect(ALICE);
    const b = t.connect(BOB);
    t.hub.subscribe(a.conn, C1, 10);
    t.hub.subscribe(b.conn, C1, 10);
    await flush(a.conn);
    await flush(b.conn);
    a.socket.sent.length = 0;
    b.socket.sent.length = 0;
    t.conversationEvents.membershipEnded(C1, ALICE);
    t.conversationEvents.membershipEnded(C2, ALICE); // 구독 없는 대화: 무시
    expect(a.socket.sent).toEqual([{ type: 'error', code: 'not_found', retryable: false, conversation_id: C1 }]);
    expect(b.socket.sent).toEqual([]);
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    await flush(a.conn);
    await flush(b.conn);
    expect(a.socket.sent).toHaveLength(1);
    expect(types(b.socket)).toEqual(['message.created']);
  });

  it('read.updated는 같은 사용자의 연결(멤버·세션 유효)에만 보낸다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.join(C1, BOB);
    const a1 = t.connect(ALICE);
    const a2 = t.connect(ALICE);
    const b = t.connect(BOB);
    const root = randomUUID();
    t.readEvents.updated({ userId: ALICE, conversationId: C1, threadRootId: root, lastReadSeq: 7, updatedAt: new Date(T0 + 9) });
    await Promise.all([flush(a1.conn), flush(a2.conn), flush(b.conn)]);
    const frame = { type: 'read.updated', conversation_id: C1, thread_root_id: root, last_read_seq: 7, updated_at: new Date(T0 + 9).toISOString() };
    expect(a1.socket.sent).toEqual([frame]);
    expect(a2.socket.sent).toEqual([frame]);
    expect(b.socket.sent).toEqual([]);

    t.st.members.delete(`${C1}:${ALICE}`);
    t.readEvents.updated({ userId: ALICE, conversationId: C1, threadRootId: null, lastReadSeq: 8, updatedAt: new Date(T0) });
    await flush(a1.conn);
    expect(a1.socket.sent).toHaveLength(1);

    t.st.sessions.delete(a2.token);
    t.join(C1, ALICE);
    t.readEvents.updated({ userId: ALICE, conversationId: C1, threadRootId: null, lastReadSeq: 9, updatedAt: new Date(T0) });
    await flush(a2.conn);
    expect(a2.socket.sent).toHaveLength(1);
    expect(a2.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
  });
});

describe('세션 만료 타이머', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  it('expiresAt에 peek가 없으면 session_expired로 닫고 타이머를 남기지 않는다', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup(() => Date.now());
    const a = t.connect(ALICE, { expiresAt: T0 + 1000 });
    await flush(a.conn); // attach 직후 세션 재확인을 먼저 끝낸다
    expect(vi.getTimerCount()).toBe(1);
    t.st.sessions.delete(a.token);
    await vi.advanceTimersByTimeAsync(999);
    expect(a.socket.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_expired' }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.hub.size()).toBe(0);
  });

  it('HTTP가 세션을 연장했으면 새 expiresAt으로 다시 예약하고 닫지 않는다', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup(() => Date.now());
    const a = t.connect(ALICE, { expiresAt: T0 + 1000 });
    await flush(a.conn); // attach 직후 세션 재확인(peek 1회)
    t.st.sessions.set(a.token, authed(ALICE, a.sessionId, a.token, T0 + 5000));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(a.socket.closes).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    expect(t.st.peekCalls).toBe(2);
    t.st.sessions.delete(a.token);
    await vi.advanceTimersByTimeAsync(4000);
    await settle();
    expect(t.st.peekCalls).toBe(3);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_expired' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('만료 시점 peek가 reject되면 닫는다', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup(() => Date.now());
    const a = t.connect(ALICE, { expiresAt: T0 + 1000 });
    await flush(a.conn); // attach 직후 세션 재확인을 먼저 끝낸다
    t.st.peekError = new Error('db down');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_expired' }]);
  });

  it('setTimeout 한계보다 먼 만료는 중간에 깨어나 다시 판정한다', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup(() => Date.now());
    const far = T0 + 2 ** 31 + 10_000;
    await flush(t.connect(ALICE, { expiresAt: far }).conn); // attach 직후 세션 재확인(peek 1회)
    await vi.advanceTimersByTimeAsync(2 ** 31 - 2);
    expect(t.st.peekCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(t.st.peekCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('detach는 타이머를 지우고 이후 전송을 막는다', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup(() => Date.now());
    const a = t.connect(ALICE, { expiresAt: T0 + 1000 });
    expect(vi.getTimerCount()).toBe(1);
    t.hub.detach(a.conn);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.hub.size()).toBe(0);
    t.hub.sendError(a.conn, 'invalid_frame', false);
    expect(a.socket.sent).toEqual([]);
    expect(a.socket.closes).toEqual([]);
  });

  it('이미 지난 expiresAt은 즉시(지연 0) 판정한다', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup(() => Date.now());
    const a = t.connect(ALICE, { expiresAt: T0 - 1 });
    await flush(a.conn); // attach 직후 세션 재확인을 먼저 끝낸다
    t.st.sessions.delete(a.token);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_expired' }]);
  });
});

describe('sendError·dispose', () => {
  it('sendError는 conversation_id가 있을 때만 싣는다', () => {
    const t = setup();
    const a = t.connect(ALICE);
    t.hub.sendError(a.conn, 'invalid_frame', false);
    t.hub.sendError(a.conn, 'not_found', false, C1);
    expect(a.socket.sent).toEqual([
      { type: 'error', code: 'invalid_frame', retryable: false },
      { type: 'error', code: 'not_found', retryable: false, conversation_id: C1 },
    ]);
  });

  it('dispose는 모든 연결을 1001로 닫고 이벤트 구독을 해제한다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    const a = t.connect(ALICE);
    const b = t.connect(BOB);
    t.hub.dispose();
    expect(a.socket.closes).toEqual([{ code: 1001, reason: 'server_shutdown' }]);
    expect(b.socket.closes).toEqual([{ code: 1001, reason: 'server_shutdown' }]);
    expect(t.hub.size()).toBe(0);

    // 해제 확인: dispose 뒤 새 연결은 이벤트를 하나도 받지 않는다.
    const c = t.connect(ALICE);
    t.hub.subscribe(c.conn, C1, 10);
    await flush(c.conn);
    c.socket.sent.length = 0;
    t.messageEvents.created({ changeId: 11, message: record(C1) });
    t.readEvents.updated({ userId: ALICE, conversationId: C1, threadRootId: null, lastReadSeq: 1, updatedAt: new Date(T0) });
    t.conversationEvents.membershipEnded(C1, ALICE);
    t.authEvents.sessionRevoked([c.sessionId]);
    await flush(c.conn);
    expect(c.socket.sent).toEqual([]);
    expect(c.socket.closes).toEqual([]);
  });
});

/** worker 발견 F1·F2 회귀(리뷰 레인에서 hub.ts 수정 후 활성화). */
describe('발견 회귀: replay 취소·실패 뒤 구독 정리', () => {
  // [F1] subscribe 태스크가 watermark/replay에서 기다리는 사이 membershipEnded가 오면 endSubscription이 구독을 지우고
  // error not_found를 보내지만, 태스크는 재확인 없이 이어서 `conversation.subscribed`를 보낸다(현재: ['error','conversation.subscribed']).
  // 클라이언트는 not_found 뒤에 ACK를 받아 구독 중이라고 믿지만 서버 subs에는 항목이 없어 live가 오지 않는다.
  it('replay 대기 중 멤버십이 끝나면 not_found만 받고 subscribed ACK는 오지 않는다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    let open!: () => void;
    t.st.watermarkGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 10);
    await vi.waitFor(() => expect(t.st.watermarkCalls).toBe(1));
    t.st.members.delete(`${C1}:${ALICE}`);
    t.conversationEvents.membershipEnded(C1, ALICE);
    open();
    await flush(a.conn);
    expect(types(a.socket)).toEqual(['error']);
  });

  // [F2] subscribe 태스크가 watermark 이후 throw(scan reject 등)하면 sync.required만 보내고 `conn.subs`에
  // `through = MAX_SAFE_INTEGER` 항목이 남는다. 그 대화의 live는 재구독 전까지 조용히 버려지고, 나중의 membershipEnded는
  // ACK한 적 없는 대화에 대해 error not_found를 보낸다(현재: ['sync.required','error']).
  it('subscribe 처리 실패 뒤 구독 항목이 남지 않는다', async () => {
    const t = setup();
    t.join(C1, ALICE);
    t.st.scanImpl = async () => {
      throw new Error('db down');
    };
    const a = t.connect(ALICE);
    t.hub.subscribe(a.conn, C1, 0);
    await flush(a.conn);
    t.conversationEvents.membershipEnded(C1, ALICE);
    expect(a.socket.sent).toEqual([{ type: 'sync.required' }]);
  });
});
