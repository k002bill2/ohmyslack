/** 테스트 전용 가짜 fetch·WebSocket(실서버 기동 금지, BRIEF ★5). 호출 순서를 `log`에 기록한다. */
import { createSessionBus } from '../../src/features/sync';
import { createHttpDataSource, type HttpDataSourceDeps } from '../../src/data/http-source.js';
import type { SocketLike } from '../../src/data/realtime.js';
import type { StorageLike } from '../../src/features/sync';

export const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ME = U(1);
export const PEER = U(2);
export const CONV = U(10);

export function message(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: U(100 + n),
    conversation_id: CONV,
    seq: n,
    author_id: PEER,
    client_message_id: U(500 + n),
    thread_root_id: null,
    body: `m${n}`,
    created_at: '2026-11-07T00:00:00Z',
    edited_at: null,
    deleted_at: null,
    mention_user_ids: [],
    root_reply_count: 0,
    ...extra,
  };
}

export type Reply = { status: number; body?: unknown } | 'network';
export type Handler = (url: URL, init: RequestInit | undefined) => Reply;

export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

export class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  readyState = 0;
  readonly sent: unknown[] = [];
  constructor(private readonly server: FakeServer) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string) {
    const frame = JSON.parse(data) as { type: string; conversation_id: string; after_cursor?: number };
    this.sent.push(frame);
    this.server.log.push(`ws ${frame.type}`);
    if (frame.type === 'conversation.subscribe' && this.server.autoAck) {
      queueMicrotask(() => this.push({ type: 'conversation.subscribed', conversation_id: frame.conversation_id, through_cursor: 0 }));
    }
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export class FakeServer {
  readonly log: string[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly routes = new Map<string, Handler>();
  autoAck = true;
  autoOpen = true;

  constructor() {
    this.on('GET /api/me', () => ({ status: 200, body: { user: { id: ME, email: 'a@x', display_name: 'A', role: 'member' }, csrf_token: 'csrf-1' } }));
    this.on('GET /api/sync', (url) => ({
      status: 200,
      body: { changes: [], through_cursor: Number(url.searchParams.get('after')), scanned_through: 0, has_more: false, next_cursor: 0 },
    }));
    this.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary()], next_cursor: null } }));
    this.on('GET /api/members', () => ({ status: 200, body: { members: [{ id: PEER, display_name: 'B', role: 'member' }] } }));
    this.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    this.on('GET /api/sync/snapshot', () => ({ status: 200, body: { snapshot_cursor: 0, conversation_id: CONV, messages: [], has_more: false, next_before_seq: null } }));
  }

  on(route: string, handler: Handler) {
    this.routes.set(route, handler);
  }

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'https://oms.test');
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    this.log.push(`${route}${url.search}`);
    const reply = this.routes.get(route)?.(url, init) ?? { status: 404 };
    if (reply === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status }));
  };

  readonly createSocket = (): FakeSocket => {
    const s = new FakeSocket(this);
    this.sockets.push(s);
    this.log.push('ws open');
    if (this.autoOpen) queueMicrotask(() => s.open());
    return s;
  };

  get socket(): FakeSocket {
    const s = this.sockets.at(-1);
    if (s === undefined) throw new Error('no socket');
    return s;
  }
}

export function summary(extra: Record<string, unknown> = {}) {
  return {
    id: CONV,
    kind: 'channel',
    name: 'general',
    peer_user_id: null,
    last_seq: 0,
    last_read_seq: 0,
    unread_count: 0,
    mention_count: 0,
    unread_thread_count: 0,
    unread_threads: [],
    ...extra,
  };
}

export function setup(overrides: Partial<HttpDataSourceDeps> = {}) {
  const server = new FakeServer();
  const storage = new MemoryStorage();
  const ended: string[] = [];
  const session = createSessionBus(() => undefined);
  session.onEnd((r) => ended.push(r));
  const ds = createHttpDataSource({
    fetch: server.fetch,
    createSocket: server.createSocket,
    wsUrl: 'wss://oms.test/api/ws',
    session,
    storage,
    isOnline: () => true,
    setTimer: () => 0,
    clearTimer: () => undefined,
    ...overrides,
  });
  return { server, storage, ds, session, ended };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
