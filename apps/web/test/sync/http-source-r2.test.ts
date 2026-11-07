/** Codex r2 지적 회귀 테스트: 스레드 기존 답글 조회(P1), 복귀 중 대화 전환(P2), catch-up 대기 확정(P2). */
import { describe, expect, it } from 'vitest';
import { readCheckpoint, writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, message, setup, summary } from './fake-server.js';

const ROOT = U(101);
const reply = (n: number) => message(n, { thread_root_id: ROOT, root_reply_count: null });

describe('Codex r2 회귀', () => {
  it('P1 새로고침 후 스레드를 열면 기존 답글을 페이지 끝까지 조회해 복원한다', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 5, storage);
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1, { root_reply_count: 3 })], has_more: false } }));
    server.on(`GET /api/messages/${ROOT}/replies`, (url) =>
      url.searchParams.get('after_seq') === '0'
        ? { status: 200, body: { root: message(1, { root_reply_count: 3 }), replies: [reply(2), reply(3)], has_more: true } }
        : { status: 200, body: { root: message(1, { root_reply_count: 3 }), replies: [reply(4)], has_more: false } },
    );
    ds.open?.(CONV);
    await ds.resume();
    ds.openThread?.(ROOT);
    for (let i = 0; i < 4; i += 1) await flush();
    const replies = ds.getSnapshot().messages.filter((m) => m.rootId === ROOT);
    expect(replies.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);
    expect(server.log).toContain(`GET /api/messages/${ROOT}/replies?after_seq=3&limit=100`);
  });

  it('P2 복귀 중 바뀐 대화를 구독하고, 그 ACK 뒤에만 「연결됨」·checkpoint 전진', async () => {
    const { server, ds, storage } = setup();
    const OTHER = U(11);
    server.autoAck = false;
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary(), summary({ id: OTHER, name: 'b' })], next_cursor: null } }));
    server.on(`GET /api/conversations/${OTHER}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    server.on('GET /api/sync', () => ({ status: 200, body: { changes: [], through_cursor: 9, scanned_through: 9, has_more: false, next_cursor: 9 } }));
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    const done = ds.resume();
    for (let i = 0; i < 6; i += 1) await flush();
    expect(server.log).toContain('ws conversation.subscribe');
    ds.open?.(OTHER);
    server.socket.push({ type: 'conversation.subscribed', conversation_id: CONV, through_cursor: 9 });
    for (let i = 0; i < 3; i += 1) await flush();
    expect(ds.getSnapshot().connection).not.toBe('connected');
    expect(readCheckpoint(ME, storage)).toBe(3);
    const subs = server.socket.sent.filter((f) => (f as { type: string }).type === 'conversation.subscribe') as { conversation_id: string }[];
    expect(subs.at(-1)?.conversation_id).toBe(OTHER);
    server.socket.push({ type: 'conversation.subscribed', conversation_id: OTHER, through_cursor: 9 });
    expect(await done).toBe(true);
    expect(ds.getSnapshot().connection).toBe('connected');
    expect(readCheckpoint(ME, storage)).toBe(9);
  });

  it('P2 REST catch-up에 내 메시지(같은 client_message_id)가 오면 전송 대기(unknown)를 확정 — 중복 표시 0', async () => {
    const { server, ds, storage } = setup({ newClientMessageId: () => U(900) });
    writeCheckpoint(ME, 0, storage);
    server.on(`POST /api/conversations/${CONV}/messages`, () => 'network');
    ds.open?.(CONV);
    await ds.resume();
    ds.send({ conversationId: CONV }, 'hi');
    for (let i = 0; i < 3; i += 1) await flush();
    expect(ds.getSnapshot().messages.find((m) => m.pending !== undefined)?.pending?.status).toBe('unknown');
    const mine = message(7, { author_id: ME, client_message_id: U(900), body: 'hi' });
    server.on('GET /api/sync', () => ({ status: 200, body: { changes: [{ change_id: 20, message: mine }], through_cursor: 20, scanned_through: 20, has_more: false, next_cursor: 20 } }));
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().messages.filter((m) => m.body === 'hi')).toHaveLength(1);
    expect(ds.getSnapshot().messages.some((m) => m.pending !== undefined)).toBe(false);
  });

  it('Codex r3: 본문 이력은 원문 전용(roots_only=true)으로 조회한다', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 5, storage);
    ds.open?.(CONV);
    await ds.resume();
    await flush();
    expect(server.log).toContain(`GET /api/conversations/${CONV}/messages?limit=100&roots_only=true`);
  });
});
