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
import { BACKGROUND_RELOAD_MS, READ_FLUSH_MS } from '../../src/data/http-source.js';
import { writeCheckpoint } from '../../src/features/sync';
import type { FetchLike } from '../../src/data/api.js';
import { CONV, ME, U, flush, message, setup, summary, type FakeServer } from './fake-server.js';

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

/** `gate`가 Promise를 돌려주는 요청은 그것이 풀릴 때까지 응답을 미룬다(조회 진행 중 상태를 만든다). */
function world(opts: { unread?: number; threads?: unknown[]; gate?: (input: string) => Promise<void> | undefined } = {}) {
  const timers = manualTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let server: FakeServer | undefined;
  const gated: FetchLike = (input, init) => {
    const wait = opts.gate?.(input);
    const go = () => server!.fetch(input, init);
    return wait === undefined ? go() : wait.then(go);
  };
  const ctx = setup({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, lifecycle: { doc, win: new EventTarget() }, fetch: gated });
  server = ctx.server;
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

/** 답글 이력 로드(누락 없는 로드 완료) — 스레드 읽음 저장의 전제(Codex r2 P2). */
async function openLoadedThread(w: ReturnType<typeof world>, root: string) {
  w.server.on(`GET /api/messages/${root}/replies`, () => ({
    status: 200,
    body: { root: message(1, { id: root }), replies: [], has_more: false },
  }));
  w.ds.openThread?.(root);
  await settle();
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
    await openLoadedThread(w, ROOT);
    await openLoadedThread(w, U(999));
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

describe('FR-SYNC-03 읽음 저장 복구(L43b, Codex r1 P2)', () => {
  it('열린 스레드의 새 답글: 목록 재조회로 unread 대상이 되면 보류한 위치를 저장한다(열어 보기만 한 스레드는 저장 안 함)', async () => {
    const ROOT = U(101);
    const w = world({ threads: [] });
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    await openLoadedThread(w, ROOT);
    // 오래된 목록에는 root가 없다 → 바로 보내지 않는다.
    w.ds.markRead?.(CONV, ROOT, 6);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    // 서버 집계: 새 답글로 root가 unread 대상이 됐다.
    w.server.on('GET /api/conversations', () => ({
      status: 200,
      body: {
        conversations: [summary({ last_seq: 6, unread_count: 0, unread_threads: [{ root_message_id: ROOT, last_read_seq: 0, last_reply_seq: 6, unread_reply_count: 1 }] })],
        next_cursor: null,
      },
    }));
    // 현재 대화 답글 프레임 → 묶음 재조회 예약.
    w.server.socket.push({ type: 'message.created', change_id: 41, conversation_id: CONV, message: message(6, { thread_root_id: ROOT }) });
    expect(w.timers.queue.filter((t) => t.ms === BACKGROUND_RELOAD_MS)).toHaveLength(1);
    w.timers.run(BACKGROUND_RELOAD_MS);
    await settle();
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: ROOT, last_read_seq: 6 }]);
  });

  it('열어 보기만 한 스레드는 재조회 뒤에도 unread 대상이 아니면 저장하지 않는다', async () => {
    const ROOT = U(101);
    const w = world({ threads: [] });
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.ds.markRead?.(CONV, ROOT, 6);
    w.server.socket.push({ type: 'message.created', change_id: 41, conversation_id: CONV, message: message(6, { thread_root_id: ROOT }) });
    w.timers.run(BACKGROUND_RELOAD_MS);
    await settle();
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
  });

  it('5xx 실패는 보낸 기록을 되돌리고 백오프 타이머로 다시 보낸다(4xx는 버린다)', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.server.on('PUT /api/read-state', () => ({ status: 500, body: { error: { code: 'internal' } } }));
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(1);
    expect(w.timers.queue.some((t) => t.ms === 1000)).toBe(true);
    w.timers.run(1000);
    await settle();
    expect(putCount(w.server.log)).toBe(2);
    expect(w.timers.queue.some((t) => t.ms === 2000)).toBe(true);
    // 같은 위치 재보고도 기록이 되돌려져 있어 막히지 않는다.
    w.server.on('PUT /api/read-state', (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      w.puts.push(body);
      return { status: 200, body: { ...body, updated_at: '2026-11-08T00:00:00Z' } };
    });
    w.timers.run(2000);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: null, last_read_seq: 5 }]);
    expect(w.ds.getSnapshot().spaces[0]?.unreadCount).toBe(0);
    expect(w.timers.queue.filter((t) => t.ms >= 1000)).toHaveLength(0);
  });

  it('네트워크 실패는 재시도 타이머를 예약하고, 끊김(offline)이 되면 복귀 완료 때 보낸다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.server.on('PUT /api/read-state', () => 'network');
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(1);
    expect(w.timers.queue.some((t) => t.ms === 1000)).toBe(true);
    w.timers.run(1000);
    await settle();
    expect(putCount(w.server.log)).toBe(2);
    // 연속 네트워크 실패 2회 → 끊김. 재시도 타이머는 더 보내지 않고 복귀 절차가 보낸다.
    expect(w.ds.getSnapshot().connection).toBe('offline');
    w.timers.run(2000);
    await settle();
    expect(putCount(w.server.log)).toBe(2);
    w.server.on('PUT /api/read-state', (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      w.puts.push(body);
      return { status: 200, body: { ...body, updated_at: '2026-11-08T00:00:00Z' } };
    });
    expect(await w.ds.resume()).toBe(true);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: null, last_read_seq: 5 }]);
  });

  it('5xx 연속 실패 백오프는 1s→2s→4s… 상한 30s이고 대화 전환 시 초기화된다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.server.on('PUT /api/read-state', () => ({ status: 500 }));
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const next = w.timers.queue.find((t) => t.ms >= 1000);
      expect(next).toBeDefined();
      delays.push(next!.ms);
      w.timers.run(next!.ms);
      await settle();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(putCount(w.server.log)).toBe(8);
    // 대화 전환 → 백오프 초기화: 다음 실패는 다시 1s.
    w.ds.open?.(U(11));
    w.ds.open?.(CONV);
    await settle();
    w.timers.run(30000);
    await settle();
    expect(w.timers.queue.some((t) => t.ms === 1000)).toBe(true);
  });
});

describe('FR-SYNC-03 읽음 저장(L43b, Codex r2 P2)', () => {
  it('답글 이력 로드가 끝나기 전 스레드 위치는 보내지 않고(버림), 로드 완료 뒤 다시 보고한 위치를 보낸다', async () => {
    const ROOT = U(101);
    const w = world({ threads: [{ root_message_id: ROOT, last_read_seq: 0, last_reply_seq: 9, unread_reply_count: 2 }] });
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    // 이력 로드 실패(미완료) → 표시 안 된 답글이 있을 수 있으므로 보내지 않는다.
    w.server.on(`GET /api/messages/${ROOT}/replies`, () => 'network');
    w.ds.openThread?.(ROOT);
    await settle();
    w.ds.markRead?.(CONV, ROOT, 9);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    // 이력을 끝까지 받아도 로드 전 위치를 되살려 보내지 않는다(그새 닫거나 위로 올렸을 수 있다, agy r2 #3).
    await openLoadedThread(w, ROOT);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    // 로드 완료 뒤 화면이 다시 보고한 위치(ThreadPanel reportSeen)를 보낸다.
    w.ds.markRead?.(CONV, ROOT, 9);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: ROOT, last_read_seq: 9 }]);
  });

  it('답글 조회 중 보고한 위치는 버린다 — 조회 완료 전에 스레드를 닫으면 조회가 끝나도 저장 0, 대조: 완료 뒤 보고는 저장 1(agy r2 #3)', async () => {
    const ROOT = U(101);
    let release = () => {};
    const pending = new Promise<void>((r) => (release = r));
    const w = world({
      threads: [{ root_message_id: ROOT, last_read_seq: 0, last_reply_seq: 9, unread_reply_count: 2 }],
      gate: (input) => (input.includes(`/api/messages/${ROOT}/replies`) ? pending : undefined),
    });
    w.server.on(`GET /api/messages/${ROOT}/replies`, () => ({ status: 200, body: { root: message(1, { id: ROOT }), replies: [], has_more: false } }));
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.ds.openThread?.(ROOT); // 답글 조회 진행 중
    await settle();
    w.ds.markRead?.(CONV, ROOT, 9); // 부분 목록 맨 아래에서 보고
    w.ds.openThread?.(null); // 조회 완료 전에 닫음 — 다시 보고할 화면이 없다
    release();
    await settle();
    expect(w.ds.getSnapshot().loadedReplies).toContain(ROOT);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    // 대조: 조회 완료 뒤 보고는 저장한다.
    w.ds.markRead?.(CONV, ROOT, 9);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: ROOT, last_read_seq: 9 }]);
  });

  it('410 snapshot 재초기화는 답글 로드 완료·보류 위치를 비우고, 열린 스레드 답글을 다시 조회한다(agy r2 #3)', async () => {
    const ROOT = U(101);
    let release = () => {};
    let reloading: Promise<void> | undefined;
    const w = world({ threads: [], gate: (input) => (input.includes('/replies') ? reloading : undefined) });
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    await openLoadedThread(w, ROOT);
    // 오래된 목록(대상 아님) → 다음 목록 재조회 뒤 다시 평가하려고 보류.
    w.ds.markRead?.(CONV, ROOT, 6);
    // 410: 그 사이 서버 목록에서는 unread 대상이 됐다 — 그래도 snapshot 이전 화면 위치는 되살리지 않는다.
    w.server.on('GET /api/conversations', () => ({
      status: 200,
      body: { conversations: [summary({ last_seq: 6, unread_threads: [{ root_message_id: ROOT, last_read_seq: 0, last_reply_seq: 6, unread_reply_count: 1 }] })], next_cursor: null },
    }));
    w.server.on('GET /api/sync', (url) =>
      url.searchParams.get('after') === '0'
        ? { status: 200, body: { changes: [], through_cursor: 0, scanned_through: 0, has_more: false, next_cursor: 0 } }
        : { status: 410 },
    );
    reloading = new Promise<void>((r) => (release = r));
    expect(await w.ds.resume()).toBe(true);
    await settle();
    expect(w.server.log.filter((l) => l.startsWith(`GET /api/messages/${ROOT}/replies`))).toHaveLength(2);
    expect(w.ds.getSnapshot().loadedReplies).not.toContain(ROOT);
    w.ds.markRead?.(CONV, ROOT, 6); // 재조회 진행 중 보고 → 버린다
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    release();
    await settle();
    expect(w.ds.getSnapshot().loadedReplies).toContain(ROOT);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(0);
    w.ds.markRead?.(CONV, ROOT, 6);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(w.puts).toEqual([{ conversation_id: CONV, thread_root_id: ROOT, last_read_seq: 6 }]);
  });

  it('stop() 뒤에는 대기 중 읽음·재시도·목록 재조회를 보내지 않는다', async () => {
    const w = world();
    w.ds.open?.(CONV);
    expect(await w.ds.resume()).toBe(true);
    w.server.on('PUT /api/read-state', () => ({ status: 503 }));
    w.ds.markRead?.(CONV, null, 5);
    w.timers.run(READ_FLUSH_MS);
    await settle();
    expect(putCount(w.server.log)).toBe(1);
    w.ds.stop();
    expect(w.timers.queue.filter((t) => t.ms === READ_FLUSH_MS || t.ms >= 1000)).toHaveLength(0);
    for (const ms of [1000, 2000, READ_FLUSH_MS, BACKGROUND_RELOAD_MS]) w.timers.run(ms);
    await settle();
    expect(putCount(w.server.log)).toBe(1);
  });
});
