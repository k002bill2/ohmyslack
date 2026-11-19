import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { splitLimits as L } from '../../ui/tokens.js';
import { SHELL_COPY } from './copy.js';
import { NAV_DEFAULT, RAIL_WIDTH, dragNav, dragThread, gridThread, navMax, nextThreadIntent, threadMax, type SplitRoom } from './split-math.js';
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

/**
 * 공간 변화 때 내비 사용자 폭만 상한 안으로 자른다. 스레드 사용자 폭(의도)은 줄이지 않는다 — 표시 폭은 CSS가
 * min(의도, 남은 공간)으로 정하고, 공간이 돌아오면 의도 폭으로 복원된다(N2·P3-1).
 * 내비 상한의 스레드 폭은 최소 폭(threadMin) — 내비는 스레드를 최소로 줄여도 본문 열 바닥을 못 지킬 때만 제한되고,
 * 내비가 넓어지면 스레드는 CSS minmax로 표시 폭만 양보한다(r3 P2-1). 상한이 navW·threadW와 무관하므로
 * 측정→클램프 순환이 없다. room.thread는 열림 여부(null)만 본다.
 * 결과 navW는 정수(navMax 내림)라 같은 입력이면 두 번째 호출은 같은 객체를 돌려준다(고정점).
 * 내비가 접혀 있으면(자동·사용자) 보이지 않는 사용자 폭은 자르지 않는다(P3-3).
 */
export function clampToRoom(prev: SplitState, room: SplitRoom, collapsed = false): SplitState {
  if (collapsed || prev.navW === null) return prev;
  const navW = Math.min(prev.navW, navMax(navLimitRoom(room)));
  return navW === prev.navW ? prev : { ...prev, navW };
}

/** 내비 상한 계산용 공간: 스레드가 열려 있으면 최소 폭으로 본다(r3 P2-1). */
function navLimitRoom(room: SplitRoom): SplitRoom {
  return { ...room, thread: room.thread === null ? null : L.threadMin };
}

/** aria-valuenow 방어: [min, max] 밖 값을 표시하지 않는다. 바닥이 CSS와 같으면 평소에는 발동하지 않는다. */
function within(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const px = (value: string): number => Number.parseFloat(value) || 0;

/** 셸 안쪽 폭(패딩 제외). clientWidth(정수 반올림) 대신 getBoundingClientRect(소수)로 — 확대·OS 배율에서 단위를 맞춘다. */
function measureInner(shell: HTMLElement | null): number | null {
  if (shell === null) return null;
  const style = getComputedStyle(shell);
  return shell.getBoundingClientRect().width - px(style.paddingLeft) - px(style.paddingRight);
}

const viewportWidth = (): number | undefined => (typeof window === 'undefined' ? undefined : window.innerWidth);

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
  // 실측은 셸 안쪽 폭 하나뿐 — navW·threadW와 무관하므로 측정→클램프 순환이 없다. resize는 측정만 하고(P3-1),
  // 자르기는 아래 layout effect가 렌더 시점의 접힘(뷰포트 matchMedia를 그 렌더에서 읽은 값)으로 한다.
  const [inner, setInner] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const onResize = () => setInner(measureInner(shell.current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [shell, enabled]);
  // 공간·폭이 바뀔 때마다 안쪽 폭을 새로 재고 내비 사용자 폭을 새 상한으로 다시 자른다(Codex r1 P2).
  // clampToRoom은 고정점이라 같은 입력이면 같은 객체 — 많아야 1회 갱신 후 멈춘다.
  useLayoutEffect(() => {
    if (!enabled) return;
    const w = measureInner(shell.current);
    setInner(w);
    if (w === null) return;
    setS((prev) => clampToRoom(prev, { inner: w, nav: 0, thread: threadOpen ? 0 : null, vw: viewportWidth() }, collapsed));
  }, [shell, enabled, inner, threadOpen, collapsed, s.navW, s.threadW]);

  if (!enabled) return { userCollapsed: false, navSplitter: null, threadSplitter: null };

  const vw = viewportWidth();
  // 내비 폭은 실측하지 않고 상태에서 계산한다(P3-1) — CSS 내비 열 = --sidebar-w(사용자 폭 또는 토큰 기본)·접힘이면 레일 토큰.
  // 렌더 중 DOM을 읽지 않으므로 접기/펼치기 직후에도 낡은 커밋 값을 보지 않는다.
  const navNow = collapsed ? RAIL_WIDTH : (s.navW ?? NAV_DEFAULT);
  /** 셸 안쪽 폭만 실측(layout effect의 inner 또는 조작 순간). 스레드 폭은 그리드 규칙 계산. */
  const roomAt = (innerNow: number | null): SplitRoom => {
    const w = innerNow ?? 0;
    return { inner: w, nav: navNow, thread: threadOpen ? gridThread(w, navNow, s.threadW, vw) : null, vw };
  };
  const room = () => roomAt(measureInner(shell.current));
  const known = roomAt(inner);
  const setNav = (w: number) => {
    const next = dragNav(w, navLimitRoom(room()));
    setS((prev) => (next.collapsed ? { ...prev, navCollapsed: true } : { ...prev, navCollapsed: false, navW: next.width }));
  };
  const toggleNav = () => setS((prev) => ({ ...prev, navCollapsed: !prev.navCollapsed }));

  const navSplitter = (
    <Splitter
      label={SHELL_COPY.navSplit}
      now={within(navNow, RAIL_WIDTH, navMax(navLimitRoom(known)))}
      min={RAIL_WIDTH}
      max={navMax(navLimitRoom(known))}
      dir={1}
      measure={() => navNow}
      onResize={(w) => {
        if (!autoCollapsed) setNav(w);
      }}
      onStep={(d) => {
        if (autoCollapsed) return;
        // 레일에서 → 는 최소 폭으로 펼친다(한 칸씩으로는 접힘 경계를 못 넘는다).
        if (collapsed && d > 0) setNav(L.navMin);
        else if (!collapsed) setNav(navNow + d * L.step);
      }}
      onEdge={(edge) => {
        // Home = navMin(레일로 접지 않음 — 접기는 Enter), End = 현재 상한. 레일에서 Home은 이미 최소라 무시(P3-1).
        if (autoCollapsed || (collapsed && edge < 0)) return;
        setNav(edge < 0 ? L.navMin : navMax(navLimitRoom(room())));
      }}
      onEnter={() => {
        if (!autoCollapsed) toggleNav();
      }}
      onReset={() => setS((prev) => ({ ...prev, navW: null, navCollapsed: false }))}
    />
  );
  // aria-valuenow·조작 기준은 실제 표시 폭 — 의도 폭이 공간보다 클 때 키가 먹통이 되지 않게. 결과는 의도 폭으로 저장.
  const shown = (r: SplitRoom): number => gridThread(r.inner, r.nav, s.threadW, vw);
  const threadNow = shown(known);
  // 넓히는 조작(요청 ≥ 조작 순간 표시 폭)은 공간에 막혀도 의도 폭을 줄이지 않는다(r4 P3-1). 끌기는 이동마다 다시 판정.
  // 표시 폭은 updater의 최신 의도(prev.threadW)로 계산 — 렌더 사이 연속 이동이 낡은 클로저 값을 보지 않게(P3-A).
  // 방향은 자르기 전 요청값(정수 — 서브픽셀 흔들림 무시)으로 판정(P3-B).
  const setThread = (w: number) => {
    const r = room();
    const next = dragThread(w, r);
    const requested = Math.round(w);
    setS((prev) => {
      const now = gridThread(r.inner, r.nav, prev.threadW, vw);
      const threadW = nextThreadIntent(prev.threadW, next, now, requested);
      return threadW === prev.threadW ? prev : { ...prev, threadW };
    });
  };
  // Home은 항상 좁힘 — 표시가 이미 하한에 막혀 있어도 의도를 최소 폭으로 저장한다(P3-B).
  const threadHome = () => setS((prev) => (prev.threadW === L.threadMin ? prev : { ...prev, threadW: L.threadMin }));
  const threadSplitter = threadOpen && (
    <Splitter
      label={SHELL_COPY.threadSplit}
      now={within(threadNow, L.threadMin, threadMax(known))}
      min={L.threadMin}
      max={threadMax(known)}
      dir={-1}
      measure={() => shown(room())}
      onResize={setThread}
      // ← 는 스레드를 넓힌다(분할선이 왼쪽으로).
      onStep={(d) => setThread(shown(room()) - d * L.step)}
      onEdge={(edge) => (edge < 0 ? threadHome() : setThread(threadMax(room())))}
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
