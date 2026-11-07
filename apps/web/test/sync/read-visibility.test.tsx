/**
 * FR-SYNC-03 컴포넌트 보조(DEV_DESIGN §6-2): 전경·열린 상태·누락 없이 표시된 위치만 읽음 요청,
 * 백그라운드·미개봉·단순 페이지 로드는 요청 0. 본문 열기만으로 스레드 답글을 읽음 처리하지 않는다(PRD §7-7).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { AppShell } from '../../src/features/layout';
import { createMemoryDataSource, type DataSource } from '../../src/data';
import { READ_FLUSH_MS } from '../../src/data/http-source.js';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, setup, summary } from './fake-server.js';

afterEach(cleanup);

const settle = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await flush();
};

/** 수동 타이머: 지연 값을 기록하고 `run()`으로 실행한다. */
function manualTimers() {
  const queue: { fn: () => void; ms: number }[] = [];
  return {
    queue,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      queue.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      const i = queue.indexOf(h as { fn: () => void; ms: number });
      if (i >= 0) queue.splice(i, 1);
    },
    run(ms: number) {
      for (const t of queue.splice(0).filter((x) => x.ms === ms)) t.fn();
    },
  };
}

function world(opts: { unread?: number; threads?: unknown[] } = {}) {
  const timers = manualTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const ctx = setup({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, lifecycle: { doc, win: new EventTarget() } });
  const puts: unknown[] = [];
  ctx.server.on('GET /api/conversations', () => ({
    status: 200,
    body: { conversations: [summary({ last_seq: 5, unread_count: opts.unread ?? 3, unread_threads: opts.threads ?? [] })], next_cursor: null },
  }));
  ctx.server.on('PUT /api/read-state', (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { conversation_id: string; thread_root_id: string | null; last_read_seq: number };
    puts.push(body);
    return { status: 200, body: { ...body, updated_at: '2026-11-08T00:00:00Z' } };
  });
  writeCheckpoint(ME, 3, ctx.storage);
  return { ...ctx, timers, doc, puts };
}

const putCount = (log: readonly string[]) => log.filter((l) => l === 'PUT /api/read-state').length;

describe('FR-SYNC-03 읽음 저장(웹 보조)', () => {
  it('FR-SYNC-03 전경에서 열린 대화의 본 위치만 묶어 1회 저장하고 응답으로 굵게를 푼다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.ds.markRead?.(CONV, null, 4);
    w.ds.markRead?.(CONV, null, 5);
    expect(putCount(w.server.log)).toBe(0);
    expect(w.timers.queue.some((t) => t.ms === READ_FLUSH_MS)).toBe(true);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: null, last_read_seq: 5 }]);
    expect(w.ds.getSnapshot().spaces[0]?.unreadCount).toBe(0);
    // 단조: 같은·더 작은 위치는 다시 보내지 않는다.
    w.ds.markRead?.(CONV, null, 5);
    w.ds.markRead?.(CONV, null, 2);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(w.puts).toHaveLength(1);
  });

  it('FR-SYNC-03 백그라운드·미개봉 대화·따라잡기 중에는 요청하지 않고, 따라잡기 완료 뒤 보류분을 보낸다', async () => {
    const w = world();
    expect(await w.ds.resume()).toBe(true);
    // 미개봉(현재 대화 아님) → 요청 0.
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    // 백그라운드 → 요청 0.
    w.ds.open?.(CONV);
    await settle();
    w.doc.visibilityState = 'hidden';
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    // 따라잡기 중(복귀 절차 진행) → 보류, 완료 뒤 송신.
    w.doc.visibilityState = 'visible';
    w.server.autoAck = false;
    const resumed = w.ds.resume();
    await settle();
    expect(w.ds.getSnapshot().connection).toBe('catching-up');
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    w.server.socket.push({ type: 'conversation.subscribed', conversation_id: CONV, through_cursor: 3 });
    expect(await resumed).toBe(true);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: null, last_read_seq: 5 }]);
  });

  it('FR-SYNC-03 스레드는 unread 대상 root만 저장하고 4xx는 재시도하지 않으며 네트워크 오류는 다음 기회에 보낸다', async () => {
    const ROOT = U(101);
    const w = world({ threads: [{ root_message_id: ROOT, last_read_seq: 0, last_reply_seq: 9, unread_reply_count: 2 }] });
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.ds.markRead?.(CONV, U(999), 9); // unread 대상 아님 → 무시
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    w.server.on('PUT /api/read-state', () => 'network');
    w.ds.markRead?.(CONV, ROOT, 9);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(1);
    w.server.on('PUT /api/read-state', () => ({ status: 400, body: { error: { code: 'invalid' } } }));
    w.ds.markRead?.(CONV, null, 4);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    // 네트워크 오류였던 스레드 위치를 함께 다시 보냈다(2건) → 400은 버린다.
    expect(putCount(w.server.log)).toBe(3);
    w.ds.markRead?.(CONV, null, 3);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(3);
  });

  it('FR-SYNC-03 전경 이탈 시 대기 중 위치를 즉시 보낸다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.ds.start();
    await settle();
    w.ds.markRead?.(CONV, null, 5);
    w.doc.visibilityState = 'hidden';
    w.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: null, last_read_seq: 5 }]);
  });
});

describe('FR-SYNC-03 화면 판정(AppShell)', () => {
  function spy(seed = createMemoryDataSource({
    spaces: [{ id: CONV, kind: 'channel', name: 'general', unreadCount: 2, mentionCount: 0, unreadThreadCount: 1, unreadThreadRoots: [U(101)] }],
    messages: [
      { id: U(101), conversationId: CONV, author: 'B', createdAt: '2026-11-08T00:00:00Z', body: 'm1', replyCount: 1, seq: 1 },
      { id: U(102), conversationId: CONV, author: 'B', createdAt: '2026-11-08T00:00:00Z', body: 'm2', replyCount: 0, seq: 2 },
      { id: U(103), conversationId: CONV, rootId: U(101), author: 'B', createdAt: '2026-11-08T00:00:00Z', body: 'r1', replyCount: 0, seq: 3 },
    ],
    connection: 'connected',
  })) {
    const calls: [string, string | null, number][] = [];
    const ds: DataSource = { ...seed, markRead: (c, r, s) => calls.push([c, r, s]) };
    return { ds, calls };
  }

  it('FR-SYNC-03 페이지 로드만으로는(대화 미개봉) 읽음을 알리지 않고, 대화를 열면 마지막 원문 seq만 알린다', async () => {
    const { ds, calls } = spy();
    render(<AppShell dataSource={ds} />);
    expect(calls).toEqual([]);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: /general/ }));
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([c, r, s]) => c === CONV && r === null && s === 2)).toBe(true);
  });

  it('FR-SYNC-03 스레드를 열면 답글 seq를 스레드 위치로 알리고, 본문 열기만으로는 스레드 위치를 알리지 않는다', async () => {
    const { ds, calls } = spy();
    render(<AppShell dataSource={ds} />);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: /general/ }));
    });
    expect(calls.some(([, r]) => r !== null)).toBe(false);
    await act(async () => {
      const summaryButton = document.querySelector<HTMLElement>(`[data-thread-summary-for="${U(101)}"]`);
      expect(summaryButton).not.toBeNull();
      fireEvent.click(summaryButton!);
    });
    expect(calls.some(([c, r, s]) => c === CONV && r === U(101) && s === 3)).toBe(true);
  });
});

