import { useSyncExternalStore } from 'react';
import { mediaQueries } from '../../ui/tokens.js';

/** 디자인 §5-1 구간. */
export type Breakpoint = 'compact' | 'medium' | 'wide';

export interface Viewport {
  readonly breakpoint: Breakpoint;
  /** width ≥ 1120px(§5-2 접힘 경계 이상). */
  readonly threadRoomy: boolean;
}

const FALLBACK: Viewport = Object.freeze({ breakpoint: 'wide', threadRoomy: true });

function matches(query: string): boolean {
  return window.matchMedia(query).matches;
}

/** 현재 폭의 구간. `matchMedia`가 없는 환경(SSR)은 wide로 본다. */
export function readViewport(): Viewport {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return FALLBACK;
  const breakpoint: Breakpoint = matches(mediaQueries.compact)
    ? 'compact'
    : matches(mediaQueries.medium)
      ? 'medium'
      : 'wide';
  return { breakpoint, threadRoomy: matches(mediaQueries.threadRoomy) };
}

let cached: Viewport = FALLBACK;
function snapshot(): Viewport {
  const next = readViewport();
  if (next.breakpoint !== cached.breakpoint || next.threadRoomy !== cached.threadRoomy) cached = next;
  return cached;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const lists = Object.values(mediaQueries).map((q) => window.matchMedia(q));
  lists.forEach((l) => l.addEventListener('change', onChange));
  return () => lists.forEach((l) => l.removeEventListener('change', onChange));
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, snapshot, () => FALLBACK);
}

/** §5-2 폭 규칙: wide + 스레드 열림 + width < 1120px → 사이드바 72px 접힘(필수). */
export function isSidebarCollapsed(viewport: Viewport, threadOpen: boolean): boolean {
  return viewport.breakpoint === 'wide' && threadOpen && !viewport.threadRoomy;
}
