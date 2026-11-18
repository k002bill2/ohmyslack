import { layoutVars, splitLimits as L } from '../../ui/tokens.js';

/** 셸 안쪽 폭(px)과 열린 패널로 정해지는 분할 한계. 본문 열이 BODY_COLUMN_MIN 아래로 줄지 않게 상한을 줄인다. */
export interface SplitRoom {
  /** 셸 안쪽 폭(패딩 제외). */
  readonly inner: number;
  /** 현재 내비 폭(접힘이면 레일 폭). */
  readonly nav: number;
  /** 스레드 폭 — 닫혀 있으면 null. */
  readonly thread: number | null;
}

/** 접힘 레일·기본 내비 폭은 레이아웃 토큰(px 문자열)에서 읽는다 — 수치를 복제하지 않는다. */
const px = (name: string): number => Number.parseInt(layoutVars[name] ?? '', 10);
const rail = px('--sidebar-w-collapsed');
export const NAV_DEFAULT = px('--sidebar-w');

/**
 * 본문 열 최소 = bodyMin − 4·gutter. 디자인의 「본문 480」은 분할선 여백까지 포함한 예산이고, CSS 그리드 본문 열은
 * calc(var(--body-min) - 4 * var(--space-3))를 바닥으로 쓴다(refresh.css). JS 상한도 같은 바닥을 써야 표시 폭 ≤ 상한이
 * 성립하고(P2-1) 재측정이 내비 폭을 깎지 않는다(P1-1). gutter = --space-3(12px)은 테스트가 고정한다.
 */
export const BODY_COLUMN_MIN = L.bodyMin - 4 * L.gutter;

/** 내비 상한: min(navMax, 안쪽 − 본문 열 최소 − 분할선 − 스레드). */
export function navMax(room: SplitRoom): number {
  const threadPart = room.thread === null ? 0 : room.thread + L.gutter;
  return Math.max(L.navMin, Math.min(L.navMax, room.inner - L.gutter - BODY_COLUMN_MIN - threadPart));
}

/** 스레드 상한: 고정 상한 없이 공간 한계(안쪽 − 본문 열 최소 − 분할선 2개 − 내비)만. 하한은 threadMin. */
export function threadMax(room: SplitRoom): number {
  return Math.max(L.threadMin, room.inner - 2 * L.gutter - BODY_COLUMN_MIN - room.nav);
}

/** 끈 내비 폭 → 결과. navCollapseBelow 아래면 접힘(레일), 아니면 [navMin, navMax]로 자른다. */
export function dragNav(width: number, room: SplitRoom): { readonly collapsed: boolean; readonly width: number } {
  if (width < L.navCollapseBelow) return { collapsed: true, width: rail };
  return { collapsed: false, width: Math.round(Math.max(L.navMin, Math.min(navMax(room), width))) };
}

/** 끈 스레드 폭을 [threadMin, threadMax]로 자른다. */
export function dragThread(width: number, room: SplitRoom): number {
  return Math.round(Math.max(L.threadMin, Math.min(threadMax(room), width)));
}

export { rail as RAIL_WIDTH };
