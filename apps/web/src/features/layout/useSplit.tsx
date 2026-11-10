import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { splitLimits as L } from '../../ui/tokens.js';
import { SHELL_COPY } from './copy.js';
import { NAV_DEFAULT, RAIL_WIDTH, dragNav, dragThread, navMax, threadMax, type SplitRoom } from './split-math.js';
import { Splitter } from './Splitter.js';

export interface SplitState {
  /** 사용자가 끈 내비 폭. null = 토큰 기본(--sidebar-w). */
  readonly navW: number | null;
  /** 사용자가 접었는가(레일). §5-2 자동 접힘과는 별개 — 둘 중 하나면 접힌다. */
  readonly navCollapsed: boolean;
  /** 사용자가 끈 스레드 폭. null = 토큰 기본(--thread-w clamp). */
  readonly threadW: number | null;
}

const INITIAL: SplitState = { navW: null, navCollapsed: false, threadW: null };

/** 사용자 폭을 현재 공간의 상한 안으로(스레드 먼저 — 내비 상한은 줄어든 스레드 폭으로 계산). 그대로면 같은 객체. */
export function clampToRoom(prev: SplitState, room: SplitRoom): SplitState {
  const threadW = prev.threadW === null || room.thread === null ? prev.threadW : Math.min(prev.threadW, threadMax(room));
  const thread = room.thread === null ? null : (threadW ?? room.thread);
  const navW = prev.navW === null ? null : Math.min(prev.navW, navMax({ ...room, thread }));
  return threadW === prev.threadW && navW === prev.navW ? prev : { ...prev, threadW, navW };
}

function width(el: Element | null | undefined): number {
  return el?.getBoundingClientRect().width ?? 0;
}

/** 셸 실측: 안쪽 폭(패딩 제외)·현재 내비·스레드 폭. */
function measureRoom(shell: HTMLElement | null): SplitRoom {
  if (shell === null) return { inner: 0, nav: NAV_DEFAULT, thread: null };
  const style = getComputedStyle(shell);
  const inner = shell.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  const thread = shell.querySelector('.thread-wide');
  return { inner, nav: width(shell.querySelector(':scope > .sidebar')), thread: thread === null ? null : width(thread) };
}

/**
 * R4 분할선(wide 전용): 내비 | 본문 | 스레드 사이 두 분할선과 사용자 폭 상태.
 * 폭은 셸의 CSS 사용자 속성(--sidebar-w·--thread-w)을 CSSOM으로 덮어써 기존 grid 규칙을 그대로 쓴다(CSP style 속성 없음).
 * 상태는 메모리만(지속 저장 없음 — 새로고침이면 기본 폭).
 */
export function useSplit(shell: RefObject<HTMLElement | null>, opts: {
  readonly enabled: boolean;
  readonly threadOpen: boolean;
  /** §5-2 자동 접힘(스레드 열림 + 1120 미만) — 이때는 사용자가 펼칠 수 없다. */
  readonly autoCollapsed: boolean;
  readonly onCloseThread: () => void;
}): {
  readonly userCollapsed: boolean;
  /** 사이드바 접기/펼치기 버튼(자동 접힘 중이면 없음). */
  readonly toggleNav?: () => void;
  readonly navSplitter: ReactNode;
  readonly threadSplitter: ReactNode;
} {
  const [s, setS] = useState<SplitState>(INITIAL);
  const { enabled, threadOpen, autoCollapsed } = opts;

  useLayoutEffect(() => {
    const el = shell.current;
    if (el === null) return;
    const set = (name: string, value: number | null) => {
      if (enabled && value !== null) el.style.setProperty(name, `${value}px`);
      else el.style.removeProperty(name);
    };
    set('--sidebar-w', s.navW);
    set('--thread-w', s.threadW);
  }, [shell, enabled, s.navW, s.threadW]);

  const collapsed = autoCollapsed || s.navCollapsed;
  // 렌더마다 레이아웃을 읽지 않도록(메시지 도착마다 셸이 다시 그려진다) 폭이 바뀔 때·창 크기 변경 때만 실측해 둔다.
  // 끌기·키 조작은 그 순간 room()으로 새로 잰다.
  const [measured, setMeasured] = useState<SplitRoom | null>(null);
  // 실측할 때마다 사용자 폭을 새 상한으로 다시 자른다 — 창을 줄이거나 사이드바를 펼치거나 스레드를 열어
  // 공간이 줄면 넓혀 둔 폭이 셸을 넘쳐 스레드가 잘리지 않게(Codex r1 P2). 바뀐 게 없으면 같은 상태를 돌려 루프가 없다.
  const remeasure = () => {
    const room = measureRoom(shell.current);
    setMeasured(room);
    setS((prev) => clampToRoom(prev, room));
  };
  useLayoutEffect(() => {
    if (enabled) remeasure();
    // remeasure는 shell·setState만 쓴다 — 의존은 공간을 바꾸는 값들.
  }, [shell, enabled, threadOpen, collapsed, s.navW, s.threadW]);
  useEffect(() => {
    if (!enabled) return;
    const onResize = remeasure;
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [shell, enabled]);

  if (!enabled) return { userCollapsed: false, navSplitter: null, threadSplitter: null };

  const room = () => measureRoom(shell.current);
  const known = measured ?? { inner: 0, nav: NAV_DEFAULT, thread: null };
  const navNow = collapsed ? RAIL_WIDTH : (s.navW ?? NAV_DEFAULT);
  const setNav = (w: number) => {
    const next = dragNav(w, room());
    setS((prev) => (next.collapsed ? { ...prev, navCollapsed: true } : { ...prev, navCollapsed: false, navW: next.width }));
  };
  const toggleNav = () => setS((prev) => ({ ...prev, navCollapsed: !prev.navCollapsed }));

  const navSplitter = (
    <Splitter
      label={SHELL_COPY.navSplit}
      now={navNow}
      min={RAIL_WIDTH}
      max={navMax(known)}
      dir={1}
      measure={() => (collapsed ? RAIL_WIDTH : room().nav)}
      onResize={(w) => {
        if (!autoCollapsed) setNav(w);
      }}
      onStep={(d) => {
        if (autoCollapsed) return;
        // 레일에서 → 는 최소 폭으로 펼친다(한 칸씩으로는 접힘 경계를 못 넘는다).
        if (collapsed && d > 0) setNav(L.navMin);
        else if (!collapsed) setNav(navNow + d * L.step);
      }}
      onEnter={() => {
        if (!autoCollapsed) toggleNav();
      }}
      onReset={() => setS((prev) => ({ ...prev, navW: null, navCollapsed: false }))}
    />
  );
  const threadNow = s.threadW ?? known.thread ?? L.threadMin;
  const threadSplitter = threadOpen && (
    <Splitter
      label={SHELL_COPY.threadSplit}
      now={threadNow}
      min={L.threadMin}
      max={threadMax(known)}
      dir={-1}
      measure={() => room().thread ?? threadNow}
      onResize={(w) => setS((prev) => ({ ...prev, threadW: dragThread(w, room()) }))}
      // ← 는 스레드를 넓힌다(분할선이 왼쪽으로).
      onStep={(d) => setS((prev) => ({ ...prev, threadW: dragThread(threadNow - d * L.step, room()) }))}
      onEnter={opts.onCloseThread}
      onReset={() => setS((prev) => ({ ...prev, threadW: null }))}
    />
  );
  return {
    userCollapsed: s.navCollapsed,
    ...(autoCollapsed ? {} : { toggleNav }),
    navSplitter,
    threadSplitter,
  };
}
