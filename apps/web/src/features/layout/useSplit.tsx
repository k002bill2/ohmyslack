import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { splitLimits as L } from '../../ui/tokens.js';
import { SHELL_COPY } from './copy.js';
import { NAV_DEFAULT, RAIL_WIDTH, dragNav, dragThread, navMax, threadMax, type SplitRoom } from './split-math.js';
import { Splitter } from './Splitter.js';

interface SplitState {
  /** 사용자가 끈 내비 폭. null = 토큰 기본(--sidebar-w). */
  readonly navW: number | null;
  /** 사용자가 접었는가(레일). §5-2 자동 접힘과는 별개 — 둘 중 하나면 접힌다. */
  readonly navCollapsed: boolean;
  /** 사용자가 끈 스레드 폭. null = 토큰 기본(--thread-w clamp). */
  readonly threadW: number | null;
}

const INITIAL: SplitState = { navW: null, navCollapsed: false, threadW: null };

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

  if (!enabled) return { userCollapsed: false, navSplitter: null, threadSplitter: null };

  const collapsed = autoCollapsed || s.navCollapsed;
  const room = () => measureRoom(shell.current);
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
      max={navMax(room())}
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
  const threadNow = s.threadW ?? room().thread ?? L.threadMin;
  const threadSplitter = threadOpen && (
    <Splitter
      label={SHELL_COPY.threadSplit}
      now={threadNow}
      min={L.threadMin}
      max={threadMax(room())}
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
