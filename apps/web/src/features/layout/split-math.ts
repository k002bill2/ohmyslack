import { layoutVars, splitLimits as L } from '../../ui/tokens.js';

/** 셸 안쪽 폭(px)과 열린 패널로 정해지는 분할 한계. 본문이 bodyMin 아래로 줄지 않게 상한을 줄인다. */
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

/** 내비 상한: min(navMax, 안쪽 − 본문 최소 − 분할선 − 스레드). */
export function navMax(room: SplitRoom): number {
  const threadPart = room.thread === null ? 0 : room.thread + L.gutter;
  return Math.max(L.navMin, Math.min(L.navMax, room.inner - L.gutter - L.bodyMin - threadPart));
}

/** 스레드 상한: min(threadMax, 안쪽 − 본문 최소 − 분할선 2개 − 내비). */
export function threadMax(room: SplitRoom): number {
  return Math.max(L.threadMin, Math.min(L.threadMax, room.inner - 2 * L.gutter - L.bodyMin - room.nav));
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
