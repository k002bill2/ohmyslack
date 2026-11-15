/** W-23 Codex P2-3: 알림 탭 `/c/:id(?thread=:root)#message-:id` → 대상 메시지 스크롤·강조, 없으면 안내, 잘못된 해시 무시. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { createMemoryDataSource, type DataSource, type Snapshot } from '../../src/data';
import { AppShell } from '../../src/features/layout';
import { ANCHOR_GRACE_MS, ANCHOR_HIGHLIGHT_MS, ANCHOR_NOTICE_MS, ANCHOR_REPLIES_TIMEOUT_MS, parseMessageAnchor } from '../../src/features/layout/message-anchor.js';
import { MESSAGE_ANCHOR_COPY } from '../../src/ui/copy.js';
import { T0 } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const M1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const R1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const M3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function seed(): Snapshot {
  return {
    spaces: [
      { id: C1, kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
      { id: C2, kind: 'channel', name: 'dev', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
    ],
    messages: [
      { id: M1, conversationId: C1, author: '홍길동', createdAt: T0, body: '안녕하세요', replyCount: 1 },
      { id: M2, conversationId: C1, author: '김철수', createdAt: T0, body: '반갑습니다', replyCount: 0 },
      { id: R1, conversationId: C1, rootId: M1, author: '김철수', createdAt: T0, body: '답장', replyCount: 0 },
      { id: M3, conversationId: C2, author: '홍길동', createdAt: T0, body: '개발 채널', replyCount: 0 },
    ],
    connection: 'connected',
  };
}

let reduced = false;
const scrollIntoView = vi.fn();

beforeEach(() => {
  installViewport(1280);
  const base = window.matchMedia;
  reduced = false;
  // 뷰포트 목은 모르는 쿼리를 거부한다 — 모션 감소 쿼리만 여기서 답한다.
  window.matchMedia = ((query: string) =>
    query === '(prefers-reduced-motion: reduce)' ? ({ matches: reduced } as MediaQueryList) : base(query)) as typeof window.matchMedia;
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open(path: string) {
  const history = createMemoryHistory(path);
  const view = render(<AppShell dataSource={createMemoryDataSource(seed())} history={history} />);
  return { history, view };
}

const item = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-message-id="${id}"]`);

describe('parseMessageAnchor', () => {
  it('`#message-<uuid>`만 받는다', () => {
    expect(parseMessageAnchor(`#message-${M1}`)).toBe(M1);
    expect(parseMessageAnchor(`#message-${M1.toUpperCase()}`)).toBe(M1.toUpperCase());
    for (const bad of ['', '#message-', '#message-m1', `#message-${M1}x`, `#msg-${M1}`, `#message-${M1}"]`, '#message-../../x', `message-${M1}`]) {
      expect(parseMessageAnchor(bad)).toBeNull();
    }
  });

  it('memory history는 해시를 경로·쿼리와 분리한다', () => {
    const h = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${R1}`);
    expect(h.pathname()).toBe(`/c/${C1}`);
    expect(h.search?.()).toBe(`?thread=${M1}`);
    expect(h.hash?.()).toBe(`#message-${R1}`);
  });
});

describe('알림 탭 위치 복원', () => {
  it('본문 메시지: 가운데로 스크롤·강조, 해시 제거, 잠시 후 강조 해제', () => {
    const { history, view } = open(`/c/${C1}#message-${M2}`);
    const list = view.container.querySelector('.conversation-pane .message-list')!;
    const target = item(list, M2)!;
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(target.getAttribute('data-highlighted')).toBe('true');
    expect(history.entries()).toEqual([`/c/${C1}`]);
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    expect(target.hasAttribute('data-highlighted')).toBe(false);
  });

  it('스레드 답글(`?thread=`): 스레드 패널이 열리고 패널 안 답글을 강조, 모션 감소면 즉시 스크롤', () => {
    reduced = true;
    const { history, view } = open(`/c/${C1}?thread=${M1}#message-${R1}`);
    expect(view.container.querySelector('.app-shell')?.getAttribute('data-thread')).toBe('open');
    const panel = view.container.querySelector('.thread-panel')!;
    const target = item(panel, R1)!;
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(target.getAttribute('data-highlighted')).toBe('true');
    expect(history.entries()).toEqual([`/c/${C1}?thread=${M1}`]);
  });

  it('강조 중에는 하단 고정(usePinBottom)이 목록을 맨 아래로 되돌리지 않는다', () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const log: string[] = [];
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set(this: Element) {
        if (this.classList.contains('message-list')) log.push('scrollTop');
      },
    });
    scrollIntoView.mockImplementation(() => log.push('scrollIntoView'));
    try {
      const ds = createMemoryDataSource(seed());
      render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}#message-${M2}`)} />);
      // 다음 스냅샷(새 메시지 등)으로 다시 렌더돼도 강조 동안은 따라 내려가지 않는다.
      act(() => ds.setConnection('connected'));
      expect(log).toContain('scrollIntoView');
      expect(log.slice(log.indexOf('scrollIntoView') + 1)).not.toContain('scrollTop');
    } finally {
      if (desc === undefined) delete (Element.prototype as unknown as Record<string, unknown>).scrollTop;
      else Object.defineProperty(Element.prototype, 'scrollTop', desc);
    }
  });

  it('불러온 범위에 없으면: 맨 아래 + 「메시지를 찾을 수 없습니다」, 잠시 후 안내 사라짐', () => {
    const { history, view } = open(`/c/${C1}#message-${MISSING}`);
    expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
    act(() => vi.advanceTimersByTime(ANCHOR_GRACE_MS));
    expect(screen.getByRole('status')).toHaveProperty('textContent', MESSAGE_ANCHOR_COPY.notFound);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-highlighted]')).toBeNull();
    expect(history.entries()).toEqual([`/c/${C1}`]);
    act(() => vi.advanceTimersByTime(ANCHOR_NOTICE_MS));
    expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
  });

  it('다른 대화의 메시지 id는 찾지 않는다(라우팅된 대화 안 DOM만 조회)', () => {
    const { history, view } = open(`/c/${C2}#message-${M1}`);
    act(() => vi.advanceTimersByTime(ANCHOR_GRACE_MS));
    expect(screen.getByText(MESSAGE_ANCHOR_COPY.notFound)).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(view.container.querySelector('.conversation-title')?.textContent).toBe('dev');
    expect(history.entries()).toEqual([`/c/${C2}`]);
  });

  it.each(['#message-m2', `#message-${M2}x`, '#message-..%2Fx', `#other-${M2}`])('잘못된 해시 %s는 무시한다', (hash) => {
    const { history, view } = open(`/c/${C1}${hash}`);
    act(() => vi.advanceTimersByTime(ANCHOR_GRACE_MS + ANCHOR_NOTICE_MS));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-highlighted]')).toBeNull();
    expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
    expect(view.container.querySelector('.conversation-title')?.textContent).toBe('general');
    expect(history.entries()).toEqual([`/c/${C1}${hash}`]);
  });

  it('해시가 없으면 아무것도 하지 않는다', () => {
    open(`/c/${C1}`);
    act(() => vi.advanceTimersByTime(ANCHOR_GRACE_MS));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
  });
});

/** 답글 조회 완료(`loadedReplies`)를 조절하는 대역 — 처음엔 비어 있고, 답글은 `deliver()` 후에 보인다. */
function slowReplies(): { ds: DataSource; deliver: () => void; bump: () => void } {
  const full = seed();
  let snap: Snapshot = { ...full, messages: full.messages.filter((m) => m.rootId === undefined), loadedReplies: [] };
  const listeners = new Set<() => void>();
  const base = createMemoryDataSource(full);
  const ds: DataSource = { ...base, getSnapshot: () => snap, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) };
  const deliver = () => {
    snap = { ...full, loadedReplies: [M1] };
    listeners.forEach((l) => l());
  };
  /** 실시간 수신처럼 메시지 배열만 새로 만든다(답글 조회는 그대로 미완료). */
  const bump = () => {
    snap = { ...snap, messages: [...snap.messages] };
    listeners.forEach((l) => l());
  };
  return { ds, deliver, bump };
}

describe('W-23b Codex r1 P2 반영', () => {
  it('스레드 대상은 답글 조회가 끝날 때까지 부재로 판정하지 않고, 늦게 온 답글을 강조한다', () => {
    const { ds, deliver } = slowReplies();
    const history = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${R1}`);
    const view = render(<AppShell dataSource={ds} history={history} />);
    act(() => {
      vi.advanceTimersByTime(ANCHOR_GRACE_MS * 2);
    });
    expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
    act(() => deliver());
    const panel = view.container.querySelector('.thread-panel')!;
    expect(item(panel, R1)?.getAttribute('data-highlighted')).toBe('true');
    expect(history.entries().at(-1)).toBe(`/c/${C1}?thread=${M1}`);
  });

  it('답글 조회가 끝나지 않으면 상한 뒤 스레드 패널에 안내한다(compact도 보임)', () => {
    installViewport(375);
    const { ds } = slowReplies();
    const history = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${MISSING}`);
    const view = render(<AppShell dataSource={ds} history={history} />);
    act(() => {
      vi.advanceTimersByTime(ANCHOR_REPLIES_TIMEOUT_MS);
    });
    const panel = view.container.querySelector('.thread-panel')!;
    expect(panel.textContent).toContain(MESSAGE_ANCHOR_COPY.notFound);
    expect(screen.getAllByText(MESSAGE_ANCHOR_COPY.notFound)).toHaveLength(1);
  });
});

describe('W-23b Codex 확인 라운드 P2 반영', () => {
  it('답글 조회가 멈춘 동안 실시간 메시지가 계속 와도 대기 상한은 처음 기다리기 시작한 시각 기준이다', () => {
    const { ds, bump } = slowReplies();
    const history = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${MISSING}`);
    const view = render(<AppShell dataSource={ds} history={history} />);
    const step = ANCHOR_REPLIES_TIMEOUT_MS / 4;
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        vi.advanceTimersByTime(step);
        bump();
      });
    }
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(view.container.querySelector('.thread-panel')?.textContent).toContain(MESSAGE_ANCHOR_COPY.notFound);
    expect(history.entries().at(-1)).toBe(`/c/${C1}?thread=${M1}`);
  });

  it('답글을 기다리는 동안 스레드를 닫으면 대기를 취소한다(이전 알림 안내가 다른 화면에 뜨지 않게) — Codex r3 P2', () => {
    const { ds } = slowReplies();
    const history = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${MISSING}`);
    const view = render(<AppShell dataSource={ds} history={history} />);
    act(() => {
      vi.advanceTimersByTime(ANCHOR_GRACE_MS);
    });
    act(() => {
      fireEvent.click(view.container.querySelector<HTMLButtonElement>('.thread-close')!);
    });
    expect(view.container.querySelector('.thread-panel')).toBeNull();
    // 안내는 ANCHOR_NOTICE_MS 뒤 사라지므로, 그보다 짧게 진행하며 매 단계 확인한다.
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        vi.advanceTimersByTime(ANCHOR_GRACE_MS);
      });
      expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
    }
  });
});
