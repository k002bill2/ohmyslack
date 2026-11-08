import { describe, expect, it } from 'vitest';
import { createAuthEvents } from '../../src/modules/auth/events.js';
import type { AuthService, Authenticated } from '../../src/modules/auth/service.js';
import { createConversationEvents } from '../../src/modules/conversations/events.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import { createMessageEvents } from '../../src/modules/messages/events.js';
import type { MessageRecord } from '../../src/modules/messages/store.js';
import { createHub, type HubSocket } from '../../src/modules/realtime/hub.js';
import { createReadEvents } from '../../src/modules/sync/events.js';
import type { ScanResult, SyncStore } from '../../src/modules/sync/store.js';
import type { WsServerFrame } from '../../src/shared.js';

/** W-09b 리뷰 회귀(Codex r1 P1 replay 취소, attach 경쟁 창). 실DB 없이 hub만 가짜 의존성으로 돌린다. */
const CID = '00000000-0000-4000-8000-0000000000c1';
const USER = 'user-1';
const SESSION = 'session-1';
const NOW = Date.parse('2026-11-07T00:00:00Z');

function message(id: string, seq: number): MessageRecord {
  return {
    id,
    conversationId: CID,
    seq,
    authorId: USER,
    authorKind: 'human',
    clientMessageId: `client-${id}`,
    threadRootId: null,
    body: `body ${seq}`,
    createdAt: new Date(NOW),
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: 0,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeSocket extends HubSocket {
  readonly frames: WsServerFrame[];
  readonly closes: { code: number | undefined; reason: string | undefined }[];
}

function fakeSocket(): FakeSocket {
  const frames: WsServerFrame[] = [];
  const closes: { code: number | undefined; reason: string | undefined }[] = [];
  return { frames, closes, send: (d) => frames.push(JSON.parse(d) as WsServerFrame), close: (code, reason) => closes.push({ code, reason }) };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

function setup(opts: { scan: () => Promise<ScanResult> }) {
  const state = { sessionValid: true, member: true };
  const authenticated = (): Authenticated =>
    ({
      token: 'tok',
      user: { id: USER, status: 'active' },
      session: { id: SESSION, userId: USER, expiresAt: new Date(NOW + 3_600_000) },
    }) as unknown as Authenticated;
  const auth = { peek: async () => (state.sessionValid ? authenticated() : undefined) } as unknown as AuthService;
  const conversations = {
    assertAccess: async () => {
      if (!state.member) throw new Error('not_found');
      return {};
    },
  } as unknown as ConversationsService;
  const syncStore = {
    watermark: async () => 10,
    retentionFloor: async () => 0,
    scan: opts.scan,
  } as unknown as SyncStore;
  const conversationEvents = createConversationEvents();
  const hub = createHub({
    auth,
    conversations,
    syncStore,
    authEvents: createAuthEvents(),
    conversationEvents,
    messageEvents: createMessageEvents(),
    readEvents: createReadEvents(),
    clock: () => NOW,
  });
  return { hub, state, conversationEvents };
}

describe('hub 리뷰 회귀', () => {
  it('replay scan 도중 멤버십이 끝나면 그 페이지 본문과 구독 ACK를 보내지 않는다(Codex r1 P1)', async () => {
    const page = deferred<ScanResult>();
    const { hub, state, conversationEvents } = setup({ scan: () => page.promise });
    const socket = fakeSocket();
    const conn = hub.attach(socket, { userId: USER, sessionId: SESSION, token: 'tok', expiresAt: new Date(NOW + 3_600_000) });
    hub.subscribe(conn, CID, 0);
    await flush();
    // scan의 멤버십 조회는 통과했고, 메시지 로딩 직전에 나가기가 commit·발행된다.
    state.member = false;
    conversationEvents.membershipEnded(CID, USER);
    page.resolve({ scannedThrough: 10, changes: [{ changeId: 5, op: 'create' as const, message: message('m5', 5) }] });
    await flush();
    const types = socket.frames.map((f) => f.type);
    expect(types).toEqual(['error']);
    expect(socket.frames[0]).toMatchObject({ type: 'error', code: 'not_found', conversation_id: CID });
    hub.dispose();
  });

  it('나가기가 DB에 commit됐지만 이벤트가 아직 없을 때도 replay 본문·ACK를 보내지 않고 구독을 끝낸다', async () => {
    const page = deferred<ScanResult>();
    const { hub, state } = setup({ scan: () => page.promise });
    const socket = fakeSocket();
    const conn = hub.attach(socket, { userId: USER, sessionId: SESSION, token: 'tok', expiresAt: new Date(NOW + 3_600_000) });
    hub.subscribe(conn, CID, 0);
    await flush();
    state.member = false;
    page.resolve({ scannedThrough: 10, changes: [{ changeId: 5, op: 'create' as const, message: message('m5', 5) }] });
    await flush();
    expect(socket.frames.map((f) => f.type)).toEqual(['error']);
    expect(socket.frames[0]).toMatchObject({ code: 'not_found', conversation_id: CID });
    hub.dispose();
  });

  it('멤버가 유지되면 replay 본문 뒤에 ACK가 온다(대조군)', async () => {
    const { hub } = setup({ scan: async () => ({ scannedThrough: 10, changes: [{ changeId: 5, op: 'create' as const, message: message('m5', 5) }] }) });
    const socket = fakeSocket();
    const conn = hub.attach(socket, { userId: USER, sessionId: SESSION, token: 'tok', expiresAt: new Date(NOW + 3_600_000) });
    hub.subscribe(conn, CID, 0);
    await flush();
    expect(socket.frames.map((f) => f.type)).toEqual(['message.created', 'conversation.subscribed']);
    hub.dispose();
  });

  it('handshake 뒤·attach 전에 세션이 폐기되면(이벤트를 놓쳐도) attach 직후 1008로 닫는다', async () => {
    const { hub, state } = setup({ scan: async () => ({ scannedThrough: 10, changes: [] }) });
    // revoke commit + sessionRevoked 발행이 attach 전에 끝났다: 허브는 이벤트를 받을 연결이 없었다.
    state.sessionValid = false;
    const socket = fakeSocket();
    hub.attach(socket, { userId: USER, sessionId: SESSION, token: 'tok', expiresAt: new Date(NOW + 3_600_000) });
    await flush();
    expect(socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
    expect(hub.size()).toBe(0);
    hub.dispose();
  });
});
