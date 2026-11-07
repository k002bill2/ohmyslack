/** W-10d: Codex r3 이월 P2 회귀 — 구독 거절(5), 1008 후 재연결(6), read.updated 병합(4). */
import { describe, expect, it } from 'vitest';
import { readCheckpoint, writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, setup, summary } from './fake-server.js';

const settle = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await flush();
};

describe('W-10d 구독 거절', () => {
  it('복귀 중 구독이 error(not_found)로 거절되면 ACK 대기를 끝내고 현재 대화를 해제·목록 갱신 → 연결됨', async () => {
    const { server, ds, storage } = setup();
    server.autoAck = false;
    let removed = false;
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: removed ? [] : [summary()], next_cursor: null } }));
    server.on('GET /api/sync', () => ({ status: 200, body: { changes: [], through_cursor: 9, scanned_through: 9, has_more: false, next_cursor: 9 } }));
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    const done = ds.resume();
    await settle();
    expect(server.log).toContain('ws conversation.subscribe');
    removed = true;
    server.socket.push({ type: 'error', code: 'not_found', retryable: false, conversation_id: CONV });
    expect(await done).toBe(true);
    expect(ds.getSnapshot().connection).toBe('connected');
    expect(ds.getSnapshot().spaces).toEqual([]);
    expect(readCheckpoint(ME, storage)).toBe(9);
  });

  it('연결 뒤 대화 전환 구독이 거절되면 목록을 다시 읽고, 다음 복귀가 그 대화를 구독하지 않는다', async () => {
    const { server, ds, storage } = setup();
    const OTHER = U(11);
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    server.autoAck = false;
    ds.open?.(OTHER);
    await settle(2);
    const listCalls = () => server.log.filter((l) => l.startsWith('GET /api/conversations?') || l === 'GET /api/conversations').length;
    const before = listCalls();
    server.socket.push({ type: 'error', code: 'not_found', retryable: false, conversation_id: OTHER });
    await settle();
    expect(listCalls()).toBe(before + 1);
    server.autoAck = true;
    const subsBefore = server.socket.sent.length;
    expect(await ds.resume()).toBe(true);
    const subs = server.socket.sent.slice(subsBefore) as { type: string; conversation_id: string }[];
    expect(subs.filter((f) => f.type === 'conversation.subscribe' && f.conversation_id === OTHER)).toHaveLength(0);
  });
});

describe('W-10d Codex r1', () => {
  it('P2 대화 전환 구독의 cursor_expired는 현재 대화를 유지한 채 catch-up·재구독한다(해제는 not_found만)', async () => {
    const { server, ds, storage } = setup();
    const OTHER = U(11);
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary(), summary({ id: OTHER, name: 'b' })], next_cursor: null } }));
    server.on(`GET /api/conversations/${OTHER}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    server.autoAck = false;
    ds.open?.(OTHER);
    await settle(2);
    const mark = server.socket.sent.length;
    server.autoAck = true;
    server.socket.push({ type: 'error', code: 'cursor_expired', retryable: false, conversation_id: OTHER });
    await settle(12);
    const subs = server.socket.sent.slice(mark) as { type: string; conversation_id: string }[];
    expect(subs.some((f) => f.type === 'conversation.subscribe' && f.conversation_id === OTHER)).toBe(true);
    expect(ds.getSnapshot().connection).toBe('connected');
  });

  it('P2 세션 종료 뒤 늦게 온 목록 응답이 대화 목록을 되살리지 않는다', async () => {
    let gate: Promise<void> | null = null;
    const ctx: { server?: ReturnType<typeof setup>['server'] } = {};
    const fetch = (input: string, init?: RequestInit): Promise<Response> => {
      const real = () => (ctx.server as NonNullable<typeof ctx.server>).fetch(input, init);
      return gate !== null && input.startsWith('/api/conversations') ? gate.then(real) : real();
    };
    const { server, ds, storage, ended } = setup({ fetch });
    ctx.server = server;
    writeCheckpoint(ME, 3, storage);
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary({ last_seq: 10, last_read_seq: 4, unread_count: 6 })], next_cursor: null } }));
    expect(await ds.resume()).toBe(true);
    let release: (() => void) | undefined;
    gate = new Promise<void>((r) => (release = r));
    server.socket.push({ type: 'read.updated', conversation_id: CONV, thread_root_id: null, last_read_seq: 6, updated_at: 'x' });
    server.on('POST /api/auth/logout', () => ({ status: 204 }));
    await ds.logout();
    expect(ended).toEqual(['logout']);
    release?.();
    await settle(6);
    expect(ds.getSnapshot().spaces).toEqual([]);
  });
});

describe('W-10d 1008 정책 종료', () => {
  it('/api/me 200이면 소켓을 다시 열고 복귀 절차(catch-up·구독)를 밟는다', async () => {
    const { server, ds, storage, ended } = setup();
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    const sockets = server.sockets.length;
    const syncs = server.log.filter((l) => l.startsWith('GET /api/sync?')).length;
    server.socket.serverClose(1008);
    await settle(10);
    expect(server.sockets.length).toBe(sockets + 1);
    expect(server.log.filter((l) => l.startsWith('GET /api/sync?')).length).toBe(syncs + 1);
    expect(ds.getSnapshot().connection).toBe('connected');
    expect(ended).toEqual([]);
  });

  it('/api/me 401이면 기존대로 세션 종료(소켓 재연결 없음)', async () => {
    const { server, ds, storage, ended } = setup();
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    const sockets = server.sockets.length;
    server.on('GET /api/me', () => ({ status: 401 }));
    server.socket.serverClose(1008);
    await settle(10);
    expect(ended).toEqual(['unauthorized']);
    expect(server.sockets.length).toBe(sockets);
  });
});

describe('W-10d read.updated', () => {
  const ROOT = U(101);
  const unread = () =>
    summary({
      last_seq: 10,
      last_read_seq: 4,
      unread_count: 6,
      mention_count: 1,
      unread_thread_count: 1,
      unread_threads: [{ root_message_id: ROOT, last_read_seq: 2, last_reply_seq: 8, unread_reply_count: 6, mention_count: 0 }],
    });

  it('다른 기기 읽음(끝까지)이 오면 배지를 0으로, 이전 seq가 늦게 와도 뒤로 가지 않는다', async () => {
    const { server, ds, storage } = setup();
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [unread()], next_cursor: null } }));
    writeCheckpoint(ME, 3, storage);
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().spaces[0]?.unreadCount).toBe(6);
    server.socket.push({ type: 'read.updated', conversation_id: CONV, thread_root_id: null, last_read_seq: 10, updated_at: 'x' });
    await settle(2);
    // 멘션은 본문·스레드 합산이라 로컬에서 0으로 만들지 않고 서버 집계(목록 재조회)를 따른다(Codex r1 P2).
    expect(ds.getSnapshot().spaces[0]).toMatchObject({ unreadCount: 0, mentionCount: 1, unreadThreadCount: 1 });
    server.socket.push({ type: 'read.updated', conversation_id: CONV, thread_root_id: null, last_read_seq: 5, updated_at: 'y' });
    await settle(2);
    expect(ds.getSnapshot().spaces[0]?.unreadCount).toBe(0);
    // 목록을 다시 읽어도(서버가 아직 4를 돌려줘도) 병합한 읽음 위치는 뒤로 가지 않는다.
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().spaces[0]?.unreadCount).toBe(0);
  });

  it('스레드 읽음(thread_root_id)이 마지막 답글까지면 미읽음 스레드 수를 줄인다', async () => {
    const { server, ds, storage } = setup();
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [unread()], next_cursor: null } }));
    writeCheckpoint(ME, 3, storage);
    expect(await ds.resume()).toBe(true);
    server.socket.push({ type: 'read.updated', conversation_id: CONV, thread_root_id: ROOT, last_read_seq: 8, updated_at: 'x' });
    await settle(2);
    expect(ds.getSnapshot().spaces[0]).toMatchObject({ unreadCount: 6, unreadThreadCount: 0 });
  });

  it('중간까지 읽음이면 서버 집계를 다시 읽어 배지를 갱신한다', async () => {
    const { server, ds, storage } = setup();
    let read = 4;
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: { conversations: [{ ...unread(), last_read_seq: read, unread_count: 10 - read }], next_cursor: null },
    }));
    writeCheckpoint(ME, 3, storage);
    expect(await ds.resume()).toBe(true);
    read = 7;
    server.socket.push({ type: 'read.updated', conversation_id: CONV, thread_root_id: null, last_read_seq: 7, updated_at: 'x' });
    await settle(4);
    expect(ds.getSnapshot().spaces[0]?.unreadCount).toBe(3);
  });
});
