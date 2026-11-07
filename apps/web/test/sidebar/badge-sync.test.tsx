/**
 * FR-SYNC-04 컴포넌트 보조(DEV_DESIGN §6-2): `read.updated` 수신 → 배지 갱신, 자기 저장 후 굵게 해제,
 * 다른 대화(배경 구독)의 새 메시지 → 목록 재조회 1회로 묶어 굵게(BRIEF ★2). 현재 대화 복귀 절차는 그대로다.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sidebar } from '../../src/features/sidebar';
import { BACKGROUND_RELOAD_MS } from '../../src/data/http-source.js';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, PEER, U, flush, message, setup, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const OTHER = U(11);
const settle = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await flush();
};

function world() {
  const timers: { fn: () => void; ms: number }[] = [];
  const ctx = setup({
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const state = { otherUnread: 0 };
  ctx.server.on('GET /api/conversations', () => ({
    status: 200,
    body: {
      conversations: [
        summary({ last_seq: 5, last_read_seq: 2, unread_count: 3 }),
        summary({ id: OTHER, name: 'other', last_seq: state.otherUnread, unread_count: state.otherUnread }),
      ],
      next_cursor: null,
    },
  }));
  ctx.server.on(`GET /api/conversations/${OTHER}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
  writeCheckpoint(ME, 3, ctx.storage);
  const run = (ms: number) => {
    for (const t of timers.splice(0).filter((x) => x.ms === ms)) t.fn();
  };
  return { ...ctx, state, timers, run };
}

const listCalls = (log: readonly string[]) => log.filter((l) => l === 'GET /api/conversations').length;
const subsTo = (sent: readonly unknown[], id: string) =>
  (sent as { type: string; conversation_id?: string }[]).filter((f) => f.type === 'conversation.subscribe' && f.conversation_id === id).length;

describe('FR-SYNC-04 배지 동기화(웹 보조)', () => {
  it('FR-SYNC-04 read.updated 수신 → 사이드바 굵게·배지가 즉시 풀린다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    const view = () => render(<Sidebar spaces={w.ds.getSnapshot().spaces} selectedId={null} collapsed={false} onSelect={() => undefined} />);
    const { unmount } = view();
    const row = () => within(screen.getByRole('navigation')).getByRole('button', { name: /general/ });
    expect(row().className).toMatch(/unread/);
    unmount();
    act(() => w.server.socket.push({ type: 'read.updated', conversation_id: CONV, thread_root_id: null, last_read_seq: 5, updated_at: '2026-11-08T00:00:00Z' }));
    expect(w.ds.getSnapshot().spaces.find((s) => s.id === CONV)?.unreadCount).toBe(0);
    view();
    expect(row().className).not.toMatch(/unread/);
  });

  it('FR-SYNC-04 참여한 다른 대화를 배경 구독하고 새 메시지는 목록 재조회 1회로 묶어 굵게 표시한다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    // 현재 대화 절차(ACK 구독)는 그대로, 다른 대화는 배경 구독.
    expect(subsTo(w.server.socket.sent, CONV)).toBe(1);
    expect(subsTo(w.server.socket.sent, OTHER)).toBe(1);
    const before = listCalls(w.server.log);
    w.state.otherUnread = 2;
    const created = (n: number, author = PEER) => ({
      type: 'message.created',
      change_id: 20 + n,
      conversation_id: OTHER,
      message: message(n, { conversation_id: OTHER, author_id: author }),
    });
    w.server.socket.push(created(1));
    w.server.socket.push(created(2));
    // 배경 대화 본문은 fold에 넣지 않는다.
    expect(w.ds.getSnapshot().messages.some((m) => m.conversationId === OTHER)).toBe(false);
    expect(w.timers.filter((t) => t.ms === BACKGROUND_RELOAD_MS)).toHaveLength(1);
    w.run(BACKGROUND_RELOAD_MS);
    await settle();
    expect(listCalls(w.server.log)).toBe(before + 1);
    expect(w.ds.getSnapshot().spaces.find((s) => s.id === OTHER)?.unreadCount).toBe(2);
    // 자기 메시지는 재조회하지 않는다.
    w.server.socket.push(created(3, ME));
    expect(w.timers.filter((t) => t.ms === BACKGROUND_RELOAD_MS)).toHaveLength(0);
  });

  it('FR-SYNC-04 대화를 바꾸면 이전 대화는 배경 구독으로 남고 새 대화는 ACK 구독한다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    const mark = w.server.socket.sent.length;
    w.ds.open?.(OTHER);
    await settle();
    const after = w.server.socket.sent.slice(mark) as { type: string; conversation_id?: string }[];
    expect(after.filter((f) => f.type === 'conversation.unsubscribe')).toHaveLength(0);
    expect(after.filter((f) => f.type === 'conversation.subscribe' && f.conversation_id === OTHER)).toHaveLength(1);
    // 이전 대화(CONV)의 새 메시지 → 목록 재조회 예약.
    w.server.socket.push({ type: 'message.created', change_id: 40, conversation_id: CONV, message: message(6) });
    expect(w.timers.filter((t) => t.ms === BACKGROUND_RELOAD_MS)).toHaveLength(1);
  });

  it('FR-SYNC-04 배경 구독 거절은 조용히 무시하고 복귀 절차를 다시 시작하지 않는다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    const me = w.server.log.filter((l) => l === 'GET /api/me').length;
    w.server.socket.push({ type: 'error', code: 'cursor_expired', retryable: false, conversation_id: OTHER });
    await settle();
    expect(w.server.log.filter((l) => l === 'GET /api/me').length).toBe(me);
    expect(w.ds.getSnapshot().connection).toBe('connected');
  });
});
