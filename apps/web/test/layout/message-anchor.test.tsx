/** W-23 Codex P2-3: 알림 탭 `/c/:id(?thread=:root)#message-:id` → 대상 메시지 스크롤·강조, 없으면 안내, 잘못된 해시 무시. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { createMemoryDataSource, type DataSource, type Snapshot } from '../../src/data';
import { AppShell } from '../../src/features/layout';
import { ANCHOR_GRACE_MS, ANCHOR_HIGHLIGHT_MS, ANCHOR_NOTICE_MS, ANCHOR_REPLIES_TIMEOUT_MS, isUserScrollInput, parseMessageAnchor } from '../../src/features/layout/message-anchor.js';
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

describe('isUserScrollInput — 직접 스크롤 판정(agy r3 #1)', () => {
  /** scope에 리스너를 달고 target에서 이벤트를 보내 판정 결과를 돌려준다(실제 버블링 경로의 target). */
  function judge(html: string, pick: (scope: HTMLElement) => Element, event: Event): boolean {
    const scope = document.createElement('div');
    scope.innerHTML = html;
    document.body.append(scope);
    let result: boolean | null = null;
    scope.addEventListener(event.type, (e) => (result = isUserScrollInput(e, scope)));
    pick(scope).dispatchEvent(event);
    scope.remove();
    if (result === null) throw new Error('not dispatched');
    return result;
  }
  const HTML = '<p class="msg">본문 <a href="#x">링크</a></p><span role="button">메뉴</span><div class="composer"><textarea></textarea><button>보내기</button><div class="hint">힌트</div></div><div contenteditable="true">편집</div>';
  const key = (k: string) => new KeyboardEvent('keydown', { key: k, bubbles: true });
  const down = () => new Event('pointerdown', { bubbles: true });
  const touch = () => new Event('touchstart', { bubbles: true });

  it('휠은 어디서든 직접 스크롤', () => {
    expect(judge(HTML, (s) => s.querySelector('textarea')!, new Event('wheel', { bubbles: true }))).toBe(true);
  });

  it('pointerdown·touchstart: 스크롤 영역 자체(스크롤바·빈 영역)와 비상호작용 내용은 직접 스크롤, 작성기·상호작용 요소는 아님', () => {
    for (const ev of [down, touch]) {
      expect(judge(HTML, (s) => s, ev())).toBe(true);
      expect(judge(HTML, (s) => s.querySelector('.msg')!, ev())).toBe(true);
      expect(judge(HTML, (s) => s.querySelector('textarea')!, ev())).toBe(false);
      expect(judge(HTML, (s) => s.querySelector('.composer button')!, ev())).toBe(false);
      expect(judge(HTML, (s) => s.querySelector('.composer .hint')!, ev())).toBe(false);
      expect(judge(HTML, (s) => s.querySelector('a')!, ev())).toBe(false);
      expect(judge(HTML, (s) => s.querySelector('[role="button"]')!, ev())).toBe(false);
    }
  });

  it('keydown: 스크롤 키만, 편집 가능 요소 밖에서만 직접 스크롤', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) expect(judge(HTML, (s) => s, key(k))).toBe(true);
    for (const k of ['a', 'Shift', 'Enter', 'Tab', 'Meta']) expect(judge(HTML, (s) => s, key(k))).toBe(false);
    for (const k of ['ArrowUp', 'PageDown', ' ', 'a', 'Shift']) {
      expect(judge(HTML, (s) => s.querySelector('textarea')!, key(k))).toBe(false);
      expect(judge(HTML, (s) => s.querySelector('[contenteditable]')!, key(k))).toBe(false);
    }
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

/**
 * 교차 검토 P2(FR-SYNC-03 「실제 열람」): 알림 탭으로 스레드 중간 답글에 들어오면 하단 고정이 먼저 맨 아래로 내려
 * 보지 않은 뒤쪽 답글까지 읽음 저장하면 안 된다. jsdom에 레이아웃이 없어 스레드 패널만 항목 1개 = 100px, 보이는 높이 300px로 흉내 낸다.
 */
describe('알림 탭 스레드 답글 진입과 읽음(교차 검토 P2)', () => {
  const ITEM = 100;
  const VIEW = 300;
  const descriptors = ['scrollHeight', 'clientHeight', 'scrollTop'].map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const);
  const tops = new WeakMap<Element, number>();
  const isPanel = (el: Element) => el.classList.contains('thread-panel');
  const height = (el: Element) => (isPanel(el) ? el.querySelectorAll('.msg-item').length * ITEM : 0);
  const REPLIES = Array.from({ length: 10 }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const MID = REPLIES[3]!;

  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return height(this); } });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPanel(this) ? VIEW : 0; } });
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) { return tops.get(this) ?? 0; },
      set(this: Element, v: number) { tops.set(this, Math.max(0, Math.min(v, height(this) - VIEW))); },
    });
    // scrollIntoView({ block: 'center' }): 패널 안 대상 항목을 가운데로.
    scrollIntoView.mockImplementation(function (this: Element) {
      const scope = this.closest('.thread-panel');
      if (scope === null) return;
      const index = Array.from(scope.querySelectorAll('.msg-item')).findIndex((el) => el.contains(this));
      scope.scrollTop = index * ITEM - (VIEW - ITEM) / 2;
      scope.dispatchEvent(new Event('scroll'));
    });
  });
  afterEach(() => {
    for (const [k, d] of descriptors) {
      if (d === undefined) delete (Element.prototype as unknown as Record<string, unknown>)[k];
      else Object.defineProperty(Element.prototype, k, d);
    }
  });

  function longThread(): { ds: DataSource; markRead: ReturnType<typeof vi.fn> } {
    const base = seed();
    const replies = REPLIES.map((id, i) => ({ id, conversationId: C1, rootId: M1, author: '김철수', createdAt: T0, body: `답글 ${i}`, replyCount: 0, seq: i + 2 }));
    const snap: Snapshot = { ...base, messages: [...base.messages.filter((m) => m.rootId === undefined).map((m) => ({ ...m, seq: 1 })), ...replies] };
    const markRead = vi.fn();
    return { ds: { ...createMemoryDataSource(snap), markRead }, markRead };
  }
  const LAST = REPLIES.length + 1;

  it('`?thread=<root>#message-<중간 답글>` 진입: 대상을 강조하고 마지막 답글 seq로 읽음 저장하지 않는다', () => {
    const { ds, markRead } = longThread();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${MID}`)} />);
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    expect(item(panel, MID)?.getAttribute('data-highlighted')).toBe('true');
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, LAST);
    expect(panel.scrollTop).toBeLessThan(panel.scrollHeight - VIEW);
  });

  it('대상을 못 찾으면 맨 아래로 내린 뒤 고정·읽음을 정상 재개한다(사용자가 실제로 맨 아래를 봄)', () => {
    const { ds, markRead } = longThread();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${MISSING}`)} />);
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, LAST);
    expect(view.container.querySelector<HTMLElement>('.thread-panel')!.scrollTop).toBe(0);
    act(() => vi.advanceTimersByTime(ANCHOR_REPLIES_TIMEOUT_MS));
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    // 앵커 처리 중에는 맨 위 그대로였다 — 맨 아래는 missing()이 내린 것.
    expect(panel.scrollTop).toBe(panel.scrollHeight - VIEW);
    expect(markRead).toHaveBeenCalledWith(C1, M1, LAST);
  });

  it('대조: 앵커 없이 같은 스레드를 열면 맨 아래로 열려 마지막 답글 seq로 읽음 저장한다', () => {
    const { ds, markRead } = longThread();
    render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}`)} />);
    expect(markRead).toHaveBeenCalledWith(C1, M1, LAST);
  });
});

/**
 * QA D-1(thread-open-latest-fix2): 스레드 끝 근처 답글 앵커가 작성기 뒤에 가려짐. 실브라우저 원인 — reveal 뒤 이미지 첨부가
 * 레이아웃되며 내용이 늘어(+320px) 부드러운 스크롤 목적지가 옛 최대 스크롤에 클램프됐다. 수정: 답글 조회 완료 뒤 reveal,
 * 강조 중 크기 변화마다 다시 맞춤(사용자 스크롤 뒤에는 안 함), 스레드 패널 scroll-padding-bottom = 작성기 높이.
 */
describe('알림 탭 스레드 앵커 위치 보정(QA D-1)', () => {
  const observers: FakeResizeObserver[] = [];
  class FakeResizeObserver {
    readonly targets: Element[] = [];
    constructor(readonly cb: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    unobserve(el: Element) {
      const i = this.targets.indexOf(el);
      if (i >= 0) this.targets.splice(i, 1);
    }
    disconnect() {
      this.targets.length = 0;
    }
  }
  /** 내용 크기 변화(이미지 로드 등)를 흉내 낸다 — 실제 ResizeObserver처럼 그 요소를 관찰 중인 관찰자에만 알린다(agy r2 #7). */
  const resize = (target: Element) => {
    for (const o of [...observers]) if (o.targets.includes(target)) o.cb([], o as unknown as ResizeObserver);
  };
  const repliesList = (panel: Element) => panel.querySelector(':scope > .thread-replies')!;
  let sh = 1000;
  const shDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  const roDesc = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');

  beforeEach(() => {
    observers.length = 0;
    sh = 1000;
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => sh });
  });
  afterEach(() => {
    if (roDesc === undefined) delete (globalThis as Record<string, unknown>).ResizeObserver;
    else Object.defineProperty(globalThis, 'ResizeObserver', roDesc);
    if (shDesc === undefined) delete (Element.prototype as unknown as Record<string, unknown>).scrollHeight;
    else Object.defineProperty(Element.prototype, 'scrollHeight', shDesc);
  });

  /** 답글은 처음부터 스냅샷에 있지만 답글 조회(`loadedReplies`)는 `ready()` 전까지 미완료. */
  function repliesPending(): { ds: DataSource; ready: () => void; markRead: ReturnType<typeof vi.fn> } {
    // seq가 있어야 ThreadPanel이 마지막 답글 위치(R1 = 3)를 보고할 수 있다(agy r2 #7).
    const full: Snapshot = { ...seed(), messages: seed().messages.map((m, i) => ({ ...m, seq: i + 1 })) };
    let snap: Snapshot = { ...full, loadedReplies: [] };
    const listeners = new Set<() => void>();
    const markRead = vi.fn();
    const ds: DataSource = { ...createMemoryDataSource(full), markRead, getSnapshot: () => snap, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) };
    const ready = () => {
      snap = { ...full, loadedReplies: [M1] };
      listeners.forEach((l) => l());
    };
    return { ds, ready, markRead };
  }

  it('스레드 대상은 답글이 DOM에 있어도 답글 조회가 끝난 뒤에 reveal한다(그동안 해시·처리 대기 유지)', () => {
    const { ds, ready } = repliesPending();
    const history = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${R1}`);
    const view = render(<AppShell dataSource={ds} history={history} />);
    const panel = view.container.querySelector('.thread-panel')!;
    expect(item(panel, R1)).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(history.entries().at(-1)).toBe(`/c/${C1}?thread=${M1}#message-${R1}`);
    act(() => ready());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(item(panel, R1));
    expect(item(panel, R1)?.getAttribute('data-highlighted')).toBe('true');
    expect(history.entries().at(-1)).toBe(`/c/${C1}?thread=${M1}`);
  });

  it('답글 조회가 끝나지 않아도 상한 뒤 DOM에 대상이 있으면 안내 대신 그 대상을 reveal한다', () => {
    const { ds } = repliesPending();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${R1}`)} />);
    act(() => vi.advanceTimersByTime(ANCHOR_REPLIES_TIMEOUT_MS));
    const panel = view.container.querySelector('.thread-panel')!;
    expect(scrollIntoView.mock.contexts[0]).toBe(item(panel, R1));
    expect(screen.queryByText(MESSAGE_ANCHOR_COPY.notFound)).toBeNull();
  });

  it('강조 중 내용 크기가 바뀌면 대상으로 다시 맞춘다(변화 1회 → 재조정 1회)', () => {
    const view = open(`/c/${C1}?thread=${M1}#message-${R1}`).view;
    const panel = view.container.querySelector('.thread-panel')!;
    const target = item(panel, R1)!;
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    act(() => resize(panel)); // 크기 그대로(관찰 시작 알림 등) → 재조정 없음
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    sh += 320; // 답글 목록(패널의 직계 자식) 안 이미지 첨부가 레이아웃됨 — 패널 상자 크기는 그대로
    act(() => resize(repliesList(panel)));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(target);
    expect(scrollIntoView.mock.calls[1]).toEqual([{ block: 'center', behavior: 'smooth' }]);
  });

  it('대조: 사용자가 직접 스크롤(휠)한 뒤에는 크기가 바뀌어도 다시 맞추지 않는다', () => {
    const view = open(`/c/${C1}?thread=${M1}#message-${R1}`).view;
    const panel = view.container.querySelector('.thread-panel')!;
    fireEvent.wheel(panel, { deltaY: -120 });
    sh += 320;
    act(() => resize(repliesList(panel)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('대조: 스크롤바 드래그(pointerdown) 뒤에도 크기가 바뀌어도 다시 맞추지 않는다 — agy r2 #4', () => {
    const view = open(`/c/${C1}?thread=${M1}#message-${R1}`).view;
    const panel = view.container.querySelector('.thread-panel')!;
    fireEvent.pointerDown(panel);
    sh += 320;
    act(() => resize(repliesList(panel)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('대조: 강조가 끝난 뒤의 크기 변화에는 다시 맞추지 않는다', () => {
    const view = open(`/c/${C1}?thread=${M1}#message-${R1}`).view;
    const panel = view.container.querySelector('.thread-panel')!;
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    sh += 320;
    act(() => resize(repliesList(panel)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('답글 조회 전·대상 강조 중에는 맨 아래여도 읽음 보고 없음, 강조가 끝나고 맨 아래면 그때 보고 — agy r2 #2·#7', () => {
    sh = 0; // 내용이 보이는 높이 이하 → 항상 맨 아래(읽음 보고 조건이 성립하는 상태에서 hold만으로 막히는지 본다)
    const { ds, ready, markRead } = repliesPending();
    render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${R1}`)} />);
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, 3);
    act(() => ready());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, 3);
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    expect(markRead).toHaveBeenCalledWith(C1, M1, 3);
  });

  it('강조가 끝나면 스레드 패널 scroll-padding-bottom을 비운다(작성기 높이 잔존 없음) — agy r2 #5', () => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('composer') ? 118 : 0;
      },
    });
    try {
      const view = open(`/c/${C1}?thread=${M1}#message-${R1}`).view;
      const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
      expect(panel.style.scrollPaddingBottom).toBe('118px');
      act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
      expect(panel.style.scrollPaddingBottom).toBe('');
    } finally {
      if (offset === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offset);
    }
  });

  it('스레드 패널 scroll-padding-bottom = sticky 작성기 높이(가운데 정렬이 작성기 뒤로 가지 않게)', () => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('composer') ? 118 : 0;
      },
    });
    try {
      const view = open(`/c/${C1}?thread=${M1}#message-${R1}`).view;
      const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
      expect(panel.querySelector(':scope > .composer')).not.toBeNull();
      expect(panel.style.scrollPaddingBottom).toBe('118px');
    } finally {
      if (offset === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offset);
    }
  });
});

/**
 * agy r2 #2(thread-open-latest-fix4): 스레드 앵커 hold는 reveal 직후(부드러운 스크롤 시작 t=0)가 아니라 대상 강조가 끝날 때
 * (3초 타이머·직접 스크롤·다른 reveal·스레드 전환) 풀린다. 그 렌더에서 고정 여부를 그때 위치로 다시 정하고 읽음을 다시 본다.
 */
describe('스레드 앵커 hold는 대상 강조가 끝날 때까지(agy r2 #2)', () => {
  const ITEM = 100;
  const VIEW = 300;
  const descriptors = ['scrollHeight', 'clientHeight', 'scrollTop'].map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const);
  const roDesc = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const tops = new WeakMap<Element, number>();
  let extra = 0;
  const isPanel = (el: Element) => el.classList.contains('thread-panel');
  const height = (el: Element) => (isPanel(el) ? el.querySelectorAll('.msg-item').length * ITEM + extra : 0);
  const REPLIES = Array.from({ length: 10 }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const LAST = REPLIES.length + 1;
  const observers: { cb: () => void; targets: Set<Element> }[] = [];
  /** 실제 ResizeObserver처럼 그 요소를 관찰 중인 관찰자에만 알린다. */
  const resized = (el: Element) => {
    for (const o of [...observers]) if (o.targets.has(el)) o.cb();
  };
  /** 패널 안 대상 항목의 가운데 정렬 위치(클램프 전). */
  const centerOf = (scope: Element, el: Element) => Array.from(scope.querySelectorAll('.msg-item')).findIndex((x) => x.contains(el)) * ITEM - (VIEW - ITEM) / 2;

  beforeEach(() => {
    extra = 0;
    observers.length = 0;
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return height(this); } });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPanel(this) ? VIEW : 0; } });
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) { return tops.get(this) ?? 0; },
      set(this: Element, v: number) { tops.set(this, Math.max(0, Math.min(v, height(this) - VIEW))); },
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        readonly targets = new Set<Element>();
        constructor(readonly cb: () => void) {
          observers.push(this);
        }
        observe(el: Element) { this.targets.add(el); }
        unobserve(el: Element) { this.targets.delete(el); }
        disconnect() { this.targets.clear(); }
      },
    });
    // 실브라우저처럼: 위치가 실제로 바뀔 때만 scroll 이벤트가 온다.
    scrollIntoView.mockImplementation(function (this: Element) {
      const scope = this.closest('.thread-panel');
      if (scope === null) return;
      const before = scope.scrollTop;
      scope.scrollTop = centerOf(scope, this);
      if (scope.scrollTop !== before) scope.dispatchEvent(new Event('scroll'));
    });
  });
  afterEach(() => {
    for (const [k, d] of descriptors) {
      if (d === undefined) delete (Element.prototype as unknown as Record<string, unknown>)[k];
      else Object.defineProperty(Element.prototype, k, d);
    }
    if (roDesc === undefined) delete (globalThis as Record<string, unknown>).ResizeObserver;
    else Object.defineProperty(globalThis, 'ResizeObserver', roDesc);
  });

  function longThread(): { ds: DataSource; markRead: ReturnType<typeof vi.fn> } {
    const base = seed();
    const replies = REPLIES.map((id, i) => ({ id, conversationId: C1, rootId: M1, author: '김철수', createdAt: T0, body: `답글 ${i}`, replyCount: 0, seq: i + 2 }));
    const snap: Snapshot = { ...base, messages: [...base.messages.filter((m) => m.rootId === undefined).map((m) => ({ ...m, seq: 1 })), ...replies] };
    const markRead = vi.fn();
    return { ds: { ...createMemoryDataSource(snap), markRead }, markRead };
  }

  it('(a) 맨 아래에 열린 패널에 같은 스레드 위쪽 답글 앵커가 오면(부드러운 스크롤) 강조 동안·끝난 뒤 위에 있으면 읽음 보고 없음', () => {
    // 부드러운 스크롤: scrollIntoView 호출 시점에는 위치가 안 바뀐다.
    scrollIntoView.mockImplementation(() => undefined);
    const { ds, markRead } = longThread();
    const history = createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[3]}`);
    history.push(`/c/${C1}?thread=${M1}`);
    const view = render(<AppShell dataSource={ds} history={history} />);
    /** 이 스레드 위치 보고만(본문 위치 보고는 별개). */
    const threadReads = () => markRead.mock.calls.filter(([, root]) => root === M1);
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    const max = panel.scrollHeight - VIEW;
    expect(panel.scrollTop).toBe(max);
    expect(markRead).toHaveBeenCalledWith(C1, M1, LAST); // 앵커 없이 맨 아래로 열림 — 정상 보고
    markRead.mockClear();
    act(() => history.back()); // 알림 탭: 같은 문서 해시 변경(popstate)
    const target = item(panel, REPLIES[3]!)!;
    expect(target.getAttribute('data-highlighted')).toBe('true');
    // t=0: 아직 맨 아래(스크롤 시작 전)여도 강조 동안은 보고하지 않는다.
    expect(threadReads()).toEqual([]);
    // 부드러운 스크롤이 대상 가운데에 도착.
    act(() => {
      panel.scrollTop = centerOf(panel, target);
      panel.dispatchEvent(new Event('scroll'));
    });
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    expect(target.hasAttribute('data-highlighted')).toBe(false);
    expect(panel.scrollTop).toBe(centerOf(panel, target));
    expect(threadReads()).toEqual([]);
  });

  it('(b) 강조 중 내용이 늘어난 뒤 강조가 끝나도 맨 아래로 끌려가지 않는다(스크롤 이벤트 없이 위치만 남은 경우)', () => {
    const { ds, markRead } = longThread();
    // 끝에서 두 번째 답글: 가운데 정렬 위치가 처음 최대 스크롤(맨 아래)에 걸린다.
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[8]}`)} />);
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    const target = item(panel, REPLIES[8]!)!;
    const at = panel.scrollTop;
    expect(at).toBe(panel.scrollHeight - VIEW);
    // 마지막 답글 이미지가 늦게 레이아웃(+320px) — 대상 가운데 위치는 그대로라 scroll 이벤트가 없다.
    extra = 320;
    act(() => resized(panel.querySelector(':scope > .thread-replies')!));
    expect(panel.scrollTop).toBe(at);
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    expect(target.hasAttribute('data-highlighted')).toBe(false);
    // 강조 뒤 다음 크기 알림·재렌더에도 그 자리.
    act(() => resized(panel));
    expect(panel.scrollTop).toBe(at);
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, LAST);
  });

  it('(c) 강조 중 직접 스크롤(휠)하면 강조·hold가 바로 풀리고, 이후 맨 아래로 내리면 읽음 보고', () => {
    const { ds, markRead } = longThread();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[3]}`)} />);
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    const target = item(panel, REPLIES[3]!)!;
    expect(target.getAttribute('data-highlighted')).toBe('true');
    act(() => {
      fireEvent.wheel(panel, { deltaY: 120 });
    });
    expect(target.hasAttribute('data-highlighted')).toBe(false);
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, LAST);
    act(() => {
      panel.scrollTop = panel.scrollHeight - VIEW;
      panel.dispatchEvent(new Event('scroll'));
    });
    expect(markRead).toHaveBeenCalledWith(C1, M1, LAST);
  });

  it('강조 중 작성기에 타이핑(일반 키·Shift·Space)하거나 작성기·버튼을 눌러도 강조·hold가 유지된다 — agy r3 #1', () => {
    const { ds, markRead } = longThread();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[8]}`)} />);
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    const target = item(panel, REPLIES[8]!)!;
    // 끝에서 두 번째 답글: 가운데 정렬 위치가 맨 아래에 걸린다 — hold가 풀리면 바로 마지막 답글 읽음이 보고되는 자리.
    expect(panel.scrollTop).toBe(panel.scrollHeight - VIEW);
    const textarea = panel.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    act(() => {
      for (const key of ['a', 'Shift', ' ']) fireEvent.keyDown(textarea, { key });
      fireEvent.change(textarea, { target: { value: 'a ' } });
      fireEvent.pointerDown(textarea);
      fireEvent.pointerDown(panel.querySelector<HTMLElement>('.composer button')!);
    });
    expect(target.getAttribute('data-highlighted')).toBe('true');
    expect(markRead).not.toHaveBeenCalledWith(C1, M1, LAST);
    // 강조가 끝나면 그때 위치(맨 아래)로 정상 보고.
    act(() => vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS));
    expect(markRead).toHaveBeenCalledWith(C1, M1, LAST);
  });

  it('대조: 패널에 포커스가 있을 때 스크롤 키(PageDown)는 직접 스크롤로 보고 강조·hold를 푼다 — agy r3 #1', () => {
    const { ds } = longThread();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[3]}`)} />);
    const panel = view.container.querySelector<HTMLElement>('.thread-panel')!;
    const target = item(panel, REPLIES[3]!)!;
    act(() => {
      fireEvent.keyDown(panel, { key: 'PageDown' });
    });
    expect(target.hasAttribute('data-highlighted')).toBe(false);
  });

  it('강조 중 원문이 삭제돼 패널이 내려가면(스레드 id 그대로) 강조·크기 관찰을 바로 끝낸다 — agy r3 #3', () => {
    const { ds: base } = longThread();
    let snap = base.getSnapshot();
    const listeners = new Set<() => void>();
    const ds: DataSource = { ...base, getSnapshot: () => snap, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) };
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[3]}`)} />);
    const target = item(view.container.querySelector('.thread-panel')!, REPLIES[3]!)!;
    const replies = target.closest('.thread-replies')!;
    expect(target.getAttribute('data-highlighted')).toBe('true');
    act(() => {
      snap = { ...snap, messages: snap.messages.filter((m) => m.id !== M1) };
      listeners.forEach((l) => l());
    });
    expect(view.container.querySelector('.thread-panel')).toBeNull();
    expect(target.hasAttribute('data-highlighted')).toBe(false);
    expect(observers.every((o) => !o.targets.has(replies))).toBe(true);
  });

  it('강조 중 스레드를 닫으면 강조(크기 관찰·hold)를 바로 끝낸다 — 남은 관찰이 떨어진 대상을 다시 스크롤하지 않게', () => {
    const { ds } = longThread();
    const view = render(<AppShell dataSource={ds} history={createMemoryHistory(`/c/${C1}?thread=${M1}#message-${REPLIES[3]}`)} />);
    const panel = () => view.container.querySelector<HTMLElement>('.thread-panel')!;
    const target = item(panel(), REPLIES[3]!)!;
    expect(target.getAttribute('data-highlighted')).toBe('true');
    act(() => {
      fireEvent.click(view.container.querySelector<HTMLElement>('.thread-close')!);
    });
    expect(target.hasAttribute('data-highlighted')).toBe(false);
    expect(observers.every((o) => !o.targets.has(target.closest('.thread-replies') ?? target))).toBe(true);
  });
});
