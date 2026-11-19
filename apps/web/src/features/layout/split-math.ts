import { layoutVars, splitLimits as L } from '../../ui/tokens.js';

/** 셸 안쪽 폭(px)과 열린 패널로 정해지는 분할 한계. 본문 열이 BODY_COLUMN_MIN 아래로 줄지 않게 상한을 줄인다. */
export interface SplitRoom {
  /** 셸 안쪽 폭(패딩 제외). */
  readonly inner: number;
  /** 현재 내비 폭(접힘이면 레일 폭). */
  readonly nav: number;
  /** 스레드 폭 — 닫혀 있으면 null. */
  readonly thread: number | null;
  /** 뷰포트 폭(--thread-w 기본값의 vw 계산용). 없으면 기본 폭 = threadMin. */
  readonly vw?: number | undefined;
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

/** 내비 상한: min(navMax, 안쪽 − 본문 열 최소 − 분할선 − 스레드). 소수 안쪽 폭(확대·OS 배율)은 내림해 정수로. */
export function navMax(room: SplitRoom): number {
  const threadPart = room.thread === null ? 0 : room.thread + L.gutter;
  return Math.max(L.navMin, Math.min(L.navMax, Math.floor(room.inner - L.gutter - BODY_COLUMN_MIN - threadPart)));
}

/** 스레드 상한: 고정 상한 없이 공간 한계(안쪽 − 본문 열 최소 − 분할선 2개 − 내비)만. 하한은 threadMin. 정수(내림). */
export function threadMax(room: SplitRoom): number {
  return Math.max(L.threadMin, Math.floor(room.inner - 2 * L.gutter - BODY_COLUMN_MIN - room.nav));
}

/** --thread-w 토큰 clamp(Apx, Bvw, Cpx)를 해석한다 — 수치를 복제하지 않고 토큰 문자열에서 읽는다. */
const THREAD_W_MATCH = /^clamp\((\d+)px,\s*(\d+)vw,\s*(\d+)px\)$/.exec(layoutVars['--thread-w'] ?? '');
// 토큰 형식이 바뀌어 해석이 실패하면 조용히 320으로 떨어지지 않고 모듈 로드 시 알린다(r3 P3-3).
if (THREAD_W_MATCH === null) throw new Error('--thread-w 토큰을 clamp(Apx, Bvw, Cpx)로 해석할 수 없습니다');
const THREAD_W = Object.freeze([Number(THREAD_W_MATCH[1]), Number(THREAD_W_MATCH[2]), Number(THREAD_W_MATCH[3])] as const);

/** 사용자 폭이 없을 때 스레드 기본 폭(px, 내림). 뷰포트 폭을 모르면 threadMin. */
export function defaultThread(vw: number | undefined): number {
  if (vw === undefined) return L.threadMin;
  const [lo, mid, hi] = THREAD_W;
  return Math.floor(Math.max(lo, Math.min(hi, (mid / 100) * vw)));
}

/**
 * 스레드 표시 폭 — CSS 그리드 규칙(minmax(--thread-min, --thread-w) 열이 본문 바닥을 먼저 채운다)과 같은 순수 계산:
 * max(threadMin, min(의도 ?? 기본, 안쪽 − 내비 − 2·gutter − 본문 열 최소)). 실측하지 않는다 — 측정→클램프 순환 차단(r2 P2-1).
 */
export function gridThread(inner: number, nav: number, intent: number | null, vw?: number): number {
  const room = Math.floor(inner - nav - 2 * L.gutter - BODY_COLUMN_MIN);
  return Math.max(L.threadMin, Math.min(intent ?? defaultThread(vw), room));
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

/**
 * 스레드 조작 결과(next)를 의도 폭으로 저장할지 정한다(r4 P3-1). 방향은 자르기 전 요청값(requested, 정수)과
 * 조작 순간 표시 폭(shown)으로 판정한다 — 결과로 판정하면 하한에 막힌 → 가 넓힘으로 보인다(P3-B).
 * 요청 < 표시면 사용자가 명시적으로 좁힌 것이라 결과를 그대로 저장한다. 그 외(넓힘·제자리)는 공간에 막혀
 * 결과가 의도보다 작아도 의도를 줄이지 않는다(의도 null이면 실제로 넓어졌을 때만 저장).
 */
export function nextThreadIntent(prev: number | null, next: number, shown: number, requested: number): number | null {
  if (requested < shown) return next;
  if (prev === null) return next > shown ? next : null;
  return Math.max(prev, next);
}

export { rail as RAIL_WIDTH };
