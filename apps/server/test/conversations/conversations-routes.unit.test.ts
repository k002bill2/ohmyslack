import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccessMetaError, markConversationGuard, registerAccessRegistry, WS_ACTIONS } from '../../src/http/access.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { UserRecord } from '../../src/modules/auth/store.js';
import { createConversationEvents } from '../../src/modules/conversations/events.js';
import { dmPairKey, normalizeChannelName } from '../../src/modules/conversations/service.js';
import type { ConversationKind, ConversationsStore, CreateChannelResult, OpenDmResult } from '../../src/modules/conversations/store.js';
import { createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp, type MemoryAuthStore } from '../support/auth-app.js';

/** conversations 라우트의 HTTP 분기(메모리 저장소). 실DB 트랜잭션·동시성은 int 테스트가 본다. */
const SECRET = ['correct', 'horse', 'battery', 'staple'].join(' ');

interface Conv {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly name: string | null;
  readonly members: Set<string>;
}

interface Fixture {
  readonly convs: Map<string, Conv>;
  createResult?: CreateChannelResult;
  dmResult?: OpenDmResult;
  readonly store: ConversationsStore;
}

function memoryConversations(auth: MemoryAuthStore): Fixture {
  const convs = new Map<string, Conv>();
  const fx: Fixture = {
    convs,
    store: {
      async findAccess(id, userId) {
        const c = convs.get(id);
        return c === undefined ? undefined : { kind: c.kind, activeMember: c.members.has(userId) };
      },
      async createChannel(ch) {
        if (fx.createResult !== undefined) return fx.createResult;
        convs.set(ch.id, { id: ch.id, kind: 'channel', name: ch.name, members: new Set([ch.creatorId]) });
        return { ok: true };
      },
      async discover(userId, after, limit) {
        return [...convs.values()]
          .filter((c) => c.kind === 'channel' && !c.members.has(userId) && (after === undefined || c.id > after))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((c) => ({ id: c.id, name: c.name ?? '' }));
      },
      async join(id, userId) {
        convs.get(id)?.members.add(userId);
      },
      async leave(id, userId) {
        return convs.get(id)?.members.delete(userId) ?? false;
      },
      async listMembers(id) {
        return [...(convs.get(id)?.members ?? [])].map((u) => ({ id: u, displayName: auth.users.get(u)?.displayName ?? '' }));
      },
      async listForUser(userId, after, limit) {
        return [...convs.values()]
          .filter((c) => c.members.has(userId) && (after === undefined || c.id > after))
          .sort((x, y) => x.id.localeCompare(y.id))
          .slice(0, limit)
          .map((c) => ({ id: c.id, kind: c.kind, name: c.name, peerUserId: null, lastSeq: 3, lastReadSeq: 1 }));
      },
      async openDm(dm) {
        return fx.dmResult ?? { ok: true, id: dm.id };
      },
    },
  };
  return fx;
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

function user(id: string, email: string, role: 'owner' | 'member'): UserRecord {
  return { id, emailNorm: email, displayName: email, passwordHash: storedHash, status: 'active', role };
}

async function signIn(app: App, email: string): Promise<Sess> {
  const res = await login(app, email, SECRET);
  return { token: sessionCookie(res) ?? '', csrf: res.json<{ csrf_token: string }>().csrf_token };
}

async function setup() {
  const auth = createMemoryAuthStore();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  auth.users.set(ownerId, user(ownerId, 'owner@example.test', 'owner'));
  auth.users.set(memberId, user(memberId, 'member@example.test', 'member'));
  const fx = memoryConversations(auth);
  const app = testApp({ authStore: auth, conversationsStore: fx.store });
  const owner = await signIn(app, 'owner@example.test');
  const member = await signIn(app, 'member@example.test');
  return { fx, app, ownerId, memberId, owner, member };
}

function call(app: App, method: 'GET' | 'POST' | 'DELETE', url: string, s: Sess, payload?: object) {
  const headers = { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${s.token}`, 'x-csrf-token': s.csrf };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

function addConv(fx: Fixture, kind: ConversationKind, members: string[], id: string = randomUUID()): string {
  fx.convs.set(id, { id, kind, name: kind === 'channel' ? `ch-${id.slice(0, 4)}` : null, members: new Set(members) });
  return id;
}

describe('conversations 라우트: 목록·탐색·생성', () => {
  it('GET /api/conversations: unread 집계 필드는 0/[]', async () => {
    const { app, fx, owner, ownerId } = await setup();
    const id = addConv(fx, 'channel', [ownerId]);
    const res = await call(app, 'GET', '/api/conversations', owner);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      conversations: [
        {
          id,
          kind: 'channel',
          name: fx.convs.get(id)?.name,
          peer_user_id: null,
          last_seq: 3,
          last_read_seq: 1,
          unread_count: 0,
          mention_count: 0,
          unread_thread_count: 0,
          unread_threads: [],
        },
      ],
      next_cursor: null,
    });
  });

  it('GET /api/conversations: cursor paging(최대 100), 범위 밖 limit·잘못된 after는 400 (Codex r1 P2)', async () => {
    const { app, fx, owner, ownerId } = await setup();
    const ids = [addConv(fx, 'channel', [ownerId]), addConv(fx, 'channel', [ownerId]), addConv(fx, 'channel', [ownerId])].sort();
    const first = (await call(app, 'GET', '/api/conversations?limit=2', owner)).json<{ conversations: { id: string }[]; next_cursor: string }>();
    expect(first.conversations.map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect(first.next_cursor).toBe(ids[1]);
    const second = (await call(app, 'GET', `/api/conversations?after=${first.next_cursor}`, owner)).json<{ conversations: { id: string }[]; next_cursor: null }>();
    expect(second.conversations.map((c) => c.id)).toEqual([ids[2]]);
    expect(second.next_cursor).toBeNull();
    expect((await call(app, 'GET', '/api/conversations?limit=101', owner)).statusCode).toBe(400);
    expect((await call(app, 'GET', '/api/conversations?after=bad', owner)).statusCode).toBe(400);
  });

  it('discover: limit 페이징·next_cursor, 잘못된 query는 400', async () => {
    const { app, fx, member } = await setup();
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    for (const id of ids) addConv(fx, 'channel', [], id);
    const first = await call(app, 'GET', '/api/conversations/discover?limit=2', member);
    expect(first.json()).toEqual({ channels: ids.slice(0, 2).map((id) => ({ id, name: fx.convs.get(id)?.name })), next_cursor: ids[1] });
    const rest = await call(app, 'GET', `/api/conversations/discover?after=${ids[1]}`, member);
    expect(rest.json<{ channels: unknown[]; next_cursor: unknown }>()).toMatchObject({ channels: [{ id: ids[2] }], next_cursor: null });
    expect((await call(app, 'GET', '/api/conversations/discover?limit=101', member)).statusCode).toBe(400);
    expect((await call(app, 'GET', '/api/conversations/discover?after=bad', member)).statusCode).toBe(400);
  });

  it('POST /api/conversations: owner 201, member 403, 빈 이름·잘못된 본문 400, 충돌 409', async () => {
    const { app, fx, owner, member } = await setup();
    const created = await call(app, 'POST', '/api/conversations', owner, { kind: 'channel', name: ' general ' });
    expect(created.statusCode).toBe(201);
    expect(fx.convs.get(created.json<{ id: string }>().id)?.name).toBe('general');
    expect((await call(app, 'POST', '/api/conversations', member, { kind: 'channel', name: 'x' })).statusCode).toBe(403);
    expect((await call(app, 'POST', '/api/conversations', owner, { kind: 'channel', name: '   ' })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/api/conversations', owner, { kind: 'dm', name: 'x' })).statusCode).toBe(400);
    fx.createResult = { ok: false, reason: 'name_taken' };
    const taken = await call(app, 'POST', '/api/conversations', owner, { kind: 'channel', name: 'general' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: { code: string } }>().error.code).toBe('name_taken');
    fx.createResult = { ok: false, reason: 'no_workspace' };
    expect((await call(app, 'POST', '/api/conversations', owner, { kind: 'channel', name: 'y' })).statusCode).toBe(403);
  });
});

describe('conversations 라우트: 대화 가드(join·leave·members)', () => {
  it('비참여자·형식 오류 id·DM join은 404, 공개 채널 join은 200', async () => {
    const { app, fx, member, ownerId } = await setup();
    const ch = addConv(fx, 'channel', [ownerId]);
    const dm = addConv(fx, 'dm', [ownerId]);
    expect((await call(app, 'GET', `/api/conversations/${ch}/members`, member)).statusCode).toBe(404);
    expect((await call(app, 'GET', '/api/conversations/not-a-uuid/members', member)).statusCode).toBe(404);
    expect((await call(app, 'POST', `/api/conversations/${randomUUID()}/join`, member)).statusCode).toBe(404);
    expect((await call(app, 'POST', `/api/conversations/${dm}/join`, member)).statusCode).toBe(404);
    const joined = await call(app, 'POST', `/api/conversations/${ch}/join`, member);
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual({ id: ch });
    const members = await call(app, 'GET', `/api/conversations/${ch}/members`, member);
    expect(members.json<{ members: unknown[] }>().members).toHaveLength(2);
    expect(members.json<{ members: { display_name: string }[] }>().members[0]).toHaveProperty('display_name');
  });

  it('leave: 채널은 204 + membershipEnded 1회, DM은 400, 나간 뒤에는 404', async () => {
    const { app, fx, member, memberId } = await setup();
    const ch = addConv(fx, 'channel', [memberId]);
    const dm = addConv(fx, 'dm', [memberId]);
    const ended: string[][] = [];
    app.conversationEvents.onMembershipEnded((c, u) => ended.push([c, u]));
    expect((await call(app, 'DELETE', `/api/conversations/${dm}/membership`, member)).statusCode).toBe(400);
    expect((await call(app, 'DELETE', `/api/conversations/${ch}/membership`, member)).statusCode).toBe(204);
    expect(ended).toEqual([[ch, memberId]]);
    expect((await call(app, 'DELETE', `/api/conversations/${ch}/membership`, member)).statusCode).toBe(404);
    expect(ended).toHaveLength(1);
  });
});

describe('conversations 라우트: POST /api/dms', () => {
  it('자기 자신 400, 저장소 거부 400, 정상 200(id), 잘못된 본문 400', async () => {
    const { app, fx, member, memberId, ownerId } = await setup();
    expect((await call(app, 'POST', '/api/dms', member, { user_id: memberId })).statusCode).toBe(400);
    const opened = await call(app, 'POST', '/api/dms', member, { user_id: ownerId });
    expect(opened.statusCode).toBe(200);
    expect(opened.json<{ id: string }>().id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call(app, 'POST', '/api/dms', member, { user_id: 'nope' })).statusCode).toBe(400);
    fx.dmResult = { ok: false };
    expect((await call(app, 'POST', '/api/dms', member, { user_id: ownerId })).statusCode).toBe(400);
  });
});

describe('conversations 서비스 도우미·이벤트', () => {
  it('normalizeChannelName: trim·NFC·case-fold, NFD와 NFC는 같은 nameNorm', () => {
    expect(normalizeChannelName('  Straße ')).toEqual({ name: 'Straße', nameNorm: 'strasse' });
    const nfc = 'Café';
    const nfd = 'Café';
    expect(normalizeChannelName(nfd).nameNorm).toBe(normalizeChannelName(nfc).nameNorm);
  });

  it('dmPairKey는 순서와 대소문자에 무관하다', () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(dmPairKey(a, b)).toBe(dmPairKey(b, a));
    expect(dmPairKey(a.toUpperCase(), b)).toBe(dmPairKey(b, a));
  });

  it('onMembershipEnded 구독 해제 후에는 호출되지 않는다', () => {
    const events = createConversationEvents();
    const seen: string[] = [];
    const off = events.onMembershipEnded((c) => seen.push(c));
    events.membershipEnded('c1', 'u');
    off();
    events.membershipEnded('c2', 'u');
    expect(seen).toEqual(['c1']);
  });
});

describe('access 레지스트리의 대화 가드 강제', () => {
  it('표식 없는 conversation·message 라우트는 등록이 거부되고, 표식이 있으면 등록된다', () => {
    const app = Fastify();
    const routes = registerAccessRegistry(app);
    const plain = async (): Promise<void> => undefined;
    for (const access of ['conversation', 'message'] as const) {
      expect(() => app.post(`/x-${access}`, { config: { access }, preHandler: plain }, async () => 'x')).toThrow(AccessMetaError);
      expect(() => app.post(`/y-${access}`, { config: { access } }, async () => 'y')).toThrow(AccessMetaError);
      const guard = markConversationGuard(async (): Promise<void> => undefined);
      expect(() => app.post(`/z-${access}`, { config: { access }, preHandler: [plain, guard] }, async () => 'z')).not.toThrow();
    }
    expect(routes.map((r) => r.url)).toEqual(['/z-conversation', '/z-message']);
  });

  it('WS 동작 표는 W-09 전까지 비어 있다', () => {
    expect(WS_ACTIONS).toHaveLength(0);
  });
});
