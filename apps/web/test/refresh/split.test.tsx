/**
 * R4 분할선(wide): 폭 계산(순수 함수)과 셸 통합(분할선 노출·Enter 접기/닫기·더블클릭 초기화·접기 버튼).
 * jsdom에는 레이아웃이 없어 폭 수치는 순수 함수로, 통합은 상태 전이로 본다. 기대값은 리터럴.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BODY_COLUMN_MIN, defaultThread as defaultThreadOf, dragNav, dragThread, gridThread as gridThreadOf, navMax, nextThreadIntent, threadMax } from '../../src/features/layout/split-math.js';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { clampToRoom, type SplitState } from '../../src/features/layout/useSplit.js';
import { layoutVars, splitLimits, tokens } from '../../src/ui/tokens.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport, resizeTo } from '../helpers/viewport.js';

afterEach(cleanup);

describe('분할 계산', () => {
  const room = { inner: 1416, nav: 260, thread: 372 };

  it('본문 열 바닥 = bodyMin − 4·gutter = 432 (CSS calc(--body-min − 4·--space-3)와 같은 값)', () => {
    expect(BODY_COLUMN_MIN).toBe(432);
    // gutter(12)와 --space-3(0.75rem = 12px)이 같다는 전제를 고정한다.
    expect(splitLimits.gutter).toBe(Number.parseFloat(tokens.space['--space-3'] ?? '') * 16);
    expect(layoutVars['--body-min']).toBe(`${splitLimits.bodyMin}px`);
  });

  it('내비 상한 = min(360, 안쪽 − 12 − 432 − (스레드 + 12))', () => {
    expect(navMax(room)).toBe(360);
    expect(navMax({ inner: 1100, nav: 260, thread: 372 })).toBe(272);
    // 너무 좁으면 하한(200)을 상한으로 둔다.
    expect(navMax({ inner: 900, nav: 260, thread: 372 })).toBe(200);
    expect(navMax({ inner: 900, nav: 260, thread: null })).toBe(360);
  });

  it('스레드 상한 = 안쪽 − 24 − 432 − 내비 (고정 상한 없음)', () => {
    expect(threadMax(room)).toBe(700);
    // 넓은 창: 560을 넘어 공간 한계(1600 − 24 − 432 − 260 = 884)까지.
    expect(threadMax({ inner: 1600, nav: 260, thread: 372 })).toBe(884);
    // 내비를 레일(72)로 접으면 그만큼 늘어난다.
    expect(threadMax({ inner: 1600, nav: 72, thread: 372 })).toBe(1072);
    expect(threadMax({ inner: 1200, nav: 260, thread: 372 })).toBe(484);
    expect(threadMax({ inner: 1000, nav: 260, thread: 372 })).toBe(320);
  });

  it('내비를 160 아래로 끌면 72px 레일, 아니면 [200, 상한]으로 자른다', () => {
    expect(dragNav(159, room)).toEqual({ collapsed: true, width: 72 });
    expect(dragNav(160, room)).toEqual({ collapsed: false, width: 200 });
    expect(dragNav(300.4, room)).toEqual({ collapsed: false, width: 300 });
    expect(dragNav(999, room)).toEqual({ collapsed: false, width: 360 });
  });

  it('스레드는 [320, 상한]으로 자른다', () => {
    expect(dragThread(100, room)).toBe(320);
    expect(dragThread(400, room)).toBe(400);
    expect(dragThread(900, room)).toBe(700);
    expect(dragThread(2000, { inner: 1600, nav: 260, thread: 372 })).toBe(884);
  });
});

async function wide(open: boolean) {
  installViewport(1440);
  const user = userEvent.setup();
  render(<AppShell dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  if (open) await user.click(screen.getByRole('button', { name: /답글 1/ }));
  return user;
}

const shell = () => document.querySelector<HTMLElement>('.app-shell');

/**
 * jsdom엔 레이아웃이 없다 — 셸 안쪽 폭만 심는다. 실제 브라우저처럼 clientWidth는 정수(내림), getBoundingClientRect는 소수.
 */
function stubInner(get: () => number): void {
  const el = shell();
  if (el === null) throw new Error('셸 없음');
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => Math.floor(get()) });
  el.getBoundingClientRect = () => ({ width: get(), height: 0, x: 0, y: 0, top: 0, left: 0, right: get(), bottom: 0, toJSON: () => ({}) }) as DOMRect;
}

describe('셸 통합', () => {
  it('wide: 내비 분할선만, 스레드가 열리면 두 번째 분할선', async () => {
    const user = await wide(false);
    expect(screen.getAllByRole('separator', { name: /폭 조절/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /답글 1/ }));
    expect(screen.getByRole('separator', { name: /스레드 폭 조절/ })).toBeTruthy();
    expect(shell()?.dataset['thread']).toBe('open');
  });

  it('medium에는 분할선이 없다', async () => {
    installViewport(800);
    render(<AppShell dataSource={memory()} />);
    expect(screen.queryByRole('separator', { name: /폭 조절/ })).toBeNull();
    expect(shell()?.dataset['split']).toBeUndefined();
  });

  it('내비 분할선 Enter → 레일로 접힘, 다시 Enter → 펼침', async () => {
    const user = await wide(false);
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    await user.keyboard('{Enter}');
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    expect(sep.getAttribute('aria-valuenow')).toBe('72');
    await user.keyboard('{Enter}');
    expect(shell()?.dataset['sidebar']).toBe('expanded');
  });

  it('사이드바 「사이드바 접기」 → 레일 + 「사이드바 펼치기」로 복귀', async () => {
    const user = await wide(false);
    await user.click(screen.getByRole('button', { name: '사이드바 접기' }));
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    await user.click(screen.getByRole('button', { name: '사이드바 펼치기' }));
    expect(shell()?.dataset['sidebar']).toBe('expanded');
  });

  it('스레드 분할선 Enter → 스레드 닫힘', async () => {
    const user = await wide(true);
    screen.getByRole('separator', { name: /스레드 폭 조절/ }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('complementary', { name: '스레드' })).toBeNull();
  });

  it('더블클릭 → 사용자 폭을 지워 토큰 기본 폭으로', async () => {
    await wide(true);
    // ← 가 실제로 넓힐 공간(1416 − 456 − 260 = 700 > 기본 327)이 있어야 의도 폭이 생긴다(r4 P3-1).
    stubInner(() => 1416);
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(shell()?.style.getPropertyValue('--thread-w')).not.toBe('');
    fireEvent.doubleClick(sep);
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('');
  });
});

describe('공간이 줄면 표시 폭만 줄고 사용자 폭(의도)은 보존(N2·P3-1)', () => {
  const base = { navW: 300, navCollapsed: false, threadW: 560 };

  it('창이 1120 안쪽(1096)으로 줄어도 스레드 의도 폭 560은 그대로 — 내비 상한은 실측 스레드 폭으로', () => {
    // 실측 스레드 = CSS가 줄인 표시 폭 320. 내비 상한 = min(360, 1096 − 12 − 432 − (320 + 12)) = 320 → 300 유지
    const next = clampToRoom(base, { inner: 1096, nav: 300, thread: 320 });
    expect(next.threadW).toBe(560);
    expect(next.navW).toBe(300);
    // 더 좁으면 자른다: 1040 − 12 − 432 − 332 = 264
    expect(clampToRoom(base, { inner: 1040, nav: 300, thread: 320 }).navW).toBe(264);
  });

  it('공간이 충분하면 같은 객체를 돌려준다(효과 루프 없음)', () => {
    expect(clampToRoom(base, { inner: 1600, nav: 300, thread: 560 })).toBe(base);
  });

  it('스레드가 닫혀 있으면 스레드 폭은 그대로 두고 내비만 본다', () => {
    const next = clampToRoom(base, { inner: 1600, nav: 300, thread: null });
    expect(next).toBe(base);
  });

  it('셸 통합: 1600에서 880으로 넓힌 뒤 1200으로 줄였다가 1600으로 되돌리면 다시 880', async () => {
    await wide(true);
    // jsdom엔 레이아웃이 없다 — 셸 안쪽 폭만 심는다. 내비 폭은 상태 계산값(기본 260), 표시 스레드는 min(의도, 상한).
    let inner = 1600;
    stubInner(() => inner);
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'Home' });
    // 320에서 ← 한 칸 16px씩 넓혀 상한(1600 − 456 − 260 = 884) 근처(320 + 35 × 16 = 880)까지.
    for (let i = 0; i < 35; i += 1) fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('880px');
    inner = 1200;
    fireEvent(window, new Event('resize'));
    // 의도 폭은 그대로, 표시 폭은 상한 1200 − 24 − 432 − 260 = 484.
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('880px');
    expect(sep.getAttribute('aria-valuenow')).toBe('484');
    expect(sep.getAttribute('aria-valuemax')).toBe('484');
    inner = 1600;
    fireEvent(window, new Event('resize'));
    expect(sep.getAttribute('aria-valuenow')).toBe('880');
  });

  it('셸 통합: 의도 폭이 공간보다 클 때 → 는 표시 폭에서 한 칸 줄인다(먹통 아님)', async () => {
    await wide(true);
    let inner = 1600;
    stubInner(() => inner);
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    // 1600 − 24 − 432 − 260 = 884
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('884px');
    inner = 1100;
    fireEvent(window, new Event('resize'));
    // 표시 폭 = 상한 1100 − 24 − 432 − 260 = 384. → 한 칸 = 368.
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('368px');
  });

  it('셸 통합: 1100(자동 접힘) 구간으로 바로 줄여도 의도 폭은 320으로 떨어지지 않는다(QA N2)', async () => {
    await wide(true);
    let inner = 1416;
    stubInner(() => inner);
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    // 1416 − 24 − 432 − 260 = 700
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('700px');
    inner = 1076;
    fireEvent(window, new Event('resize'));
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('700px');
    // 표시 폭 = max(320, min(700, 1076 − 24 − 432 − 260 = 360)) = 360
    expect(sep.getAttribute('aria-valuenow')).toBe('360');
  });
});

describe('Home/End 큰 이동(P3-2, APG Window Splitter)', () => {
  it('스레드: Home = 320, End = 현재 상한', async () => {
    await wide(true);
    stubInner(() => 1416);
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    expect(fireEvent.keyDown(sep, { key: 'End' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('700px');
    expect(fireEvent.keyDown(sep, { key: 'Home' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('320px');
  });

  it('내비: Home = 200(레일로 접지 않음), End = 현재 상한', async () => {
    await wide(false);
    stubInner(() => 1416);
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    expect(fireEvent.keyDown(sep, { key: 'Home' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('200px');
    expect(shell()?.dataset['sidebar']).toBe('expanded');
    expect(fireEvent.keyDown(sep, { key: 'End' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('360px');
  });

  it('내비: 레일(사용자 접힘)에서 Home은 무시한다 — 이미 최소(P3-1). 펼치기는 → 와 Enter', async () => {
    await wide(false);
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'Enter' });
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    expect(sep.getAttribute('aria-valuenow')).toBe('72');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(shell()?.dataset['sidebar']).toBe('expanded');
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('200px');
  });

  it('자동 접힘 중 내비 분할선의 Home/End는 무시한다', async () => {
    installViewport(1100);
    const user = userEvent.setup();
    render(<AppShell dataSource={memory()} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.click(screen.getByRole('button', { name: /답글 1/ }));
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'Home' });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('');
  });
});

/**
 * CSS 그리드 해석 흉내(P3-2): 표시 스레드 = max(320, min(의도, 안쪽 − 내비 − 24 − 432)).
 * 재측정마다 clampToRoom을 다시 돌려 고정점인지(값이 변하지 않는지) 본다.
 */
function gridThread(inner: number, nav: number, intent: number): number {
  return Math.max(splitLimits.threadMin, Math.min(intent, inner - nav - 2 * splitLimits.gutter - BODY_COLUMN_MIN));
}
function settle(start: SplitState, inner: number, rounds: number, collapsed = false): SplitState[] {
  const out: SplitState[] = [];
  let s = start;
  for (let i = 0; i < rounds; i += 1) {
    const nav = collapsed ? 72 : (s.navW ?? 260);
    s = clampToRoom(s, { inner, nav, thread: gridThread(inner, nav, s.threadW ?? 320) }, collapsed);
    out.push(s);
  }
  return out;
}

describe('본문 바닥 통일(교차 검토 P1-1·P2-1)', () => {
  it('시나리오 A: 안쪽 1276, 내비 360, 스레드 의도 536 → 재측정 3회에도 내비 360 유지', () => {
    const start = { navW: 360, navCollapsed: false, threadW: 536 };
    for (const s of settle(start, 1276, 4)) expect(s).toBe(start);
    // 이때 본문 열 = 1276 − 360 − 24 − 460 = 432 (바닥).
    expect(1276 - 360 - 24 - gridThread(1276, 360, 536)).toBe(BODY_COLUMN_MIN);
  });

  it('시나리오 B: 안쪽 1300, 내비 300, 의도 724 — 레일로 접었다 펼쳐도 내비 300·본문 ≥ 432', () => {
    const start = { navW: 300, navCollapsed: true, threadW: 724 };
    const folded = settle(start, 1300, 3, true);
    for (const s of folded) expect(s.navW).toBe(300);
    const opened = settle({ ...folded[2]!, navCollapsed: false }, 1300, 4);
    for (const s of opened) expect(s.navW).toBe(300);
    expect(1300 - 300 - 24 - gridThread(1300, 300, 724)).toBeGreaterThanOrEqual(BODY_COLUMN_MIN);
  });

  it('자동 접힘(collapsed) 중에는 숨겨진 내비 navW를 자르지 않는다(P3-3)', () => {
    const prev = { navW: 360, navCollapsed: false, threadW: 900 };
    expect(clampToRoom(prev, { inner: 1076, nav: 72, thread: 548 }, true)).toBe(prev);
  });

  it('어느 공간에서도 표시 스레드 ≤ 스레드 상한 → ←/End가 스레드를 좁히지 않는다', () => {
    for (const inner of [1096, 1200, 1276, 1300, 1416, 1600, 1900]) {
      for (const nav of [72, 200, 260, 360]) {
        for (const intent of [320, 536, 724, 2000]) {
          const shown = gridThread(inner, nav, intent);
          const max = threadMax({ inner, nav, thread: shown });
          expect(shown).toBeLessThanOrEqual(max);
          expect(dragThread(shown + splitLimits.step, { inner, nav, thread: shown })).toBeGreaterThanOrEqual(shown);
          expect(dragThread(max, { inner, nav, thread: shown })).toBeGreaterThanOrEqual(shown);
        }
      }
    }
  });

  it('셸 통합: aria-valuenow는 [valuemin, valuemax] 안이고 평소엔 clamp가 발동하지 않는다', async () => {
    await wide(true);
    stubInner(() => 1300);
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    const now = Number(sep.getAttribute('aria-valuenow'));
    const max = Number(sep.getAttribute('aria-valuemax'));
    expect(now).toBeLessThanOrEqual(max);
    expect(now).toBeGreaterThanOrEqual(Number(sep.getAttribute('aria-valuemin')));
    // 기본 폭 = --thread-w clamp(320px, 32vw, 380px)를 뷰포트 폭으로 계산(내림). 의도 폭 = 기본 + 10 × 16이
    // 상한 1300 − 456 − 260(내비 기본) = 584 안이므로 그대로 보인다.
    const base = Math.floor(Math.min(380, Math.max(320, 0.32 * window.innerWidth)));
    expect(now).toBe(base + 10 * 16);
    expect(max).toBe(584);
  });
});

/**
 * 측정→클램프 순환 차단(교차 검토 r2 P2-1·P3-1). 실브라우저: 안쪽 폭은 소수(확대·OS 배율), clientWidth는 정수.
 * CSS 스레드는 소수 그대로(gridThread). 재측정마다 clampToRoom을 돌려도 navW가 변하지 않아야 한다.
 */
function settleFrac(start: SplitState, actual: number, rounds: number): SplitState[] {
  const out: SplitState[] = [];
  let s = start;
  for (let i = 0; i < rounds; i += 1) {
    const nav = s.navW ?? 260;
    // 셸이 보고하는 값: 안쪽은 정수 clientWidth(옛 측정)·소수 rect 둘 중 무엇이든, 스레드는 CSS 소수 폭.
    s = clampToRoom(s, { inner: Math.floor(actual), nav, thread: gridThread(actual, nav, s.threadW ?? 320) });
    out.push(s);
  }
  return out;
}

describe('측정→클램프 순환 차단(r2 P2-1·P3-1)', () => {
  it('소수 셸 폭 1276.4(clientWidth 1276), navW 360, 의도 536 → 재측정 10회에도 navW 360', () => {
    const start = { navW: 360, navCollapsed: false, threadW: 536 };
    for (const s of settleFrac(start, 1276.4, 10)) expect(s.navW).toBe(360);
  });

  it('소수 셸 폭 1300.6·확대 110%(1280/1.1 ≈ 1163.64) → 재측정 10회 동안 navW는 최대 1회만 바뀌고 고정', () => {
    for (const [actual, start] of [
      [1300.6, { navW: 360, navCollapsed: false, threadW: 500 }],
      [1280 / 1.1, { navW: 360, navCollapsed: false, threadW: 400 }],
    ] as const) {
      const seq = settleFrac(start, actual, 10);
      const distinct = new Set(seq.map((s) => s.navW));
      expect(distinct.size).toBeLessThanOrEqual(1);
      const last = seq[seq.length - 1]!;
      expect(Number.isInteger(last.navW)).toBe(true);
    }
  });

  it('고정점: clampToRoom(clampToRoom(x)) 는 같은 객체(정수·소수 입력 모두) → setState 연쇄 없음', () => {
    for (const inner of [1000.4, 1096, 1163.64, 1276.4, 1300.6, 1416, 1600.25]) {
      for (const navW of [200, 260, 300, 360]) {
        for (const threadW of [null, 320, 536, 900]) {
          for (const thread of [null, 0, 333.3, 460.4]) {
            const room = { inner, nav: navW, thread };
            const once = clampToRoom({ navW, navCollapsed: false, threadW }, room);
            expect(clampToRoom(once, room)).toBe(once);
            if (once.navW !== null) expect(Number.isInteger(once.navW)).toBe(true);
          }
        }
      }
    }
  });

  it('소수 공간에서도 표시 스레드 ≤ 상한, ←/End가 좁히지 않는다', () => {
    for (const inner of [1163.64, 1276.4, 1300.6, 1416.5]) {
      for (const nav of [72, 200, 260.4, 360]) {
        for (const intent of [null, 320, 536, 2000]) {
          const room = { inner, nav, thread: 0 };
          const shown = gridThreadOf(inner, nav, intent, 1440);
          const max = threadMax(room);
          expect(shown).toBeLessThanOrEqual(max);
          expect(dragThread(shown + splitLimits.step, room)).toBeGreaterThanOrEqual(shown);
          expect(dragThread(max, room)).toBeGreaterThanOrEqual(shown);
        }
      }
    }
  });

  it('셸 통합: 스레드 열림 1400 → 1100(자동 접힘 구간) 한 번에(resize가 media query보다 먼저) → 숨은 navW 보존, 1400 복귀 시 원래 폭', async () => {
    installViewport(1400);
    const user = userEvent.setup();
    render(<AppShell dataSource={memory()} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.click(screen.getByRole('button', { name: /답글 1/ }));
    let inner = 1400;
    stubInner(() => inner);
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('360px');
    act(() => {
      // 1000은 medium(분할 없음)이라 wide 안의 자동 접힘 구간 1100(안쪽 1076)으로 줄인다.
      inner = 1076;
      // 실브라우저 순서: resize 이벤트가 먼저, media query change가 나중.
      window.dispatchEvent(new Event('resize'));
      resizeTo(1100);
    });
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('360px');
    act(() => {
      inner = 1400;
      window.dispatchEvent(new Event('resize'));
      resizeTo(1400);
    });
    expect(shell()?.dataset['sidebar']).toBe('expanded');
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('360px');
  });

  it('셸 통합: 소수 셸 폭에서 resize 10회 반복해도 내비 폭 불변', async () => {
    await wide(true);
    stubInner(() => 1276.4);
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    const before = shell()?.style.getPropertyValue('--sidebar-w');
    for (let i = 0; i < 10; i += 1) fireEvent(window, new Event('resize'));
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe(before);
    expect(Number(sep.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(sep.getAttribute('aria-valuemax')));
  });
});

describe('내비 상한은 스레드 최소 폭 기준(r3 P2-1)·렌더 중 DOM 읽기 없음(P3-1)·토큰 해석(P3-3)', () => {
  it('defaultThread: --thread-w clamp(320px, 32vw, 380px) 해석 — 1280 → 380, 1024 → 327', () => {
    expect(defaultThreadOf(1280)).toBe(380);
    expect(defaultThreadOf(1024)).toBe(327);
  });

  it('clampToRoom: 내비 상한은 스레드 의도·내비 폭과 무관(스레드 = 320) — 1300/772/220은 자르지 않는다', () => {
    const prev = { navW: 360, navCollapsed: false, threadW: 772 };
    // min(360, ⌊1300 − 12 − 432 − 332⌋ = 524) = 360
    expect(clampToRoom(prev, { inner: 1300, nav: 360, thread: 0 })).toBe(prev);
    // 1100: 1100 − 12 − 432 − 332 = 324
    expect(clampToRoom(prev, { inner: 1100, nav: 360, thread: 0 }).navW).toBe(324);
  });

  async function rail772() {
    await wide(true);
    stubInner(() => 1300);
    fireEvent(window, new Event('resize'));
    const nav = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    const thread = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    // 레일에서 스레드 End → 의도 772(1300 − 24 − 432 − 72).
    fireEvent.keyDown(nav, { key: 'Enter' });
    fireEvent.keyDown(thread, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    return { nav, thread };
  }

  it('셸 통합 r3 재현: 1300·의도 772·내비 200 → → 키 216, End 360, 의도 772 유지', async () => {
    const { nav } = await rail772();
    fireEvent.keyDown(nav, { key: 'Enter' });
    fireEvent.keyDown(nav, { key: 'Home' });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('200px');
    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('216px');
    expect(nav.getAttribute('aria-valuemax')).toBe('360');
    fireEvent.keyDown(nav, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('360px');
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
  });

  it('셸 통합 r3 재현: 내비 220(끌기)에서 오른쪽 끌기 → 넓어짐', async () => {
    const { nav } = await rail772();
    fireEvent.keyDown(nav, { key: 'Enter' });
    // 펼침 기본 260에서 왼쪽으로 40 끌어 220.
    fireEvent.pointerDown(nav, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(nav, { clientX: 460, pointerId: 1 });
    fireEvent.pointerUp(nav, { clientX: 460, pointerId: 1 });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('220px');
    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('236px');
    fireEvent.pointerDown(nav, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(nav, { clientX: 580, pointerId: 1 });
    fireEvent.pointerUp(nav, { clientX: 580, pointerId: 1 });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('316px');
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
  });

  it('셸 통합: 1300·의도 724·내비 296에서 접으면 스레드 aria가 즉시 724/772(낡은 DOM 아님)', async () => {
    const { nav, thread } = await rail772();
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(thread, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('724px');
    fireEvent.keyDown(nav, { key: 'Enter' });
    fireEvent.keyDown(nav, { key: 'Home' });
    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(nav, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--sidebar-w')).toBe('296px');
    // 펼침: 표시 스레드 = min(724, 1300 − 296 − 456 = 548)
    expect(thread.getAttribute('aria-valuenow')).toBe('548');
    expect(thread.getAttribute('aria-valuemax')).toBe('548');
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(thread.getAttribute('aria-valuenow')).toBe('724');
    expect(thread.getAttribute('aria-valuemax')).toBe('772');
  });

  it('렌더 중 사이드바 getBoundingClientRect를 읽지 않는다', async () => {
    await wide(true);
    stubInner(() => 1300);
    const sidebar = document.querySelector<HTMLElement>('.app-shell > .sidebar');
    if (sidebar === null) throw new Error('사이드바 없음');
    let reads = 0;
    sidebar.getBoundingClientRect = () => {
      reads += 1;
      return { width: 999, height: 0, x: 0, y: 0, top: 0, left: 0, right: 999, bottom: 0, toJSON: () => ({}) } as DOMRect;
    };
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('separator', { name: /내비게이션 폭 조절/ }), { key: 'ArrowRight' });
    expect(reads).toBe(0);
  });
});

describe('넓히는 조작이 공간에 막혀도 사용자 폭(의도)은 줄지 않는다(r4 P3-1)', () => {
  /** 1300·의도 772(레일에서 End) → 내비 펼침(기본 260) → 표시 스레드 = min(772, 1300 − 260 − 456 = 584). */
  async function blocked772() {
    await wide(true);
    stubInner(() => 1300);
    fireEvent(window, new Event('resize'));
    const nav = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    const thread = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    fireEvent.keyDown(nav, { key: 'Enter' });
    fireEvent.keyDown(thread, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(thread.getAttribute('aria-valuenow')).toBe('584');
    return { nav, thread };
  }

  it('1300/772/260: ← → 의도 772 유지 → 내비 접기 → 스레드 aria 772', async () => {
    const { nav, thread } = await blocked772();
    fireEvent.keyDown(thread, { key: 'ArrowLeft' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    expect(thread.getAttribute('aria-valuenow')).toBe('584');
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(thread.getAttribute('aria-valuenow')).toBe('772');
  });

  it('1300/772/260: End → 의도 772 유지 → 내비 접기 → 스레드 aria 772', async () => {
    const { nav, thread } = await blocked772();
    fireEvent.keyDown(thread, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(thread.getAttribute('aria-valuenow')).toBe('772');
  });

  it('1300/772/260: 분할선을 왼쪽으로 공간 끝까지 끌어도 의도 772 유지', async () => {
    const { nav, thread } = await blocked772();
    fireEvent.pointerDown(thread, { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(thread, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(thread, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(thread, { clientX: 100, pointerId: 1 });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(thread.getAttribute('aria-valuenow')).toBe('772');
  });

  it('1300/772/260: 한 제스처에서 왼쪽 끝까지 넓혔다가 오른쪽으로 좁히면 좁힌 폭(484)이 저장된다', async () => {
    const { thread } = await blocked772();
    fireEvent.pointerDown(thread, { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(thread, { clientX: 100, pointerId: 1 });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    // 시작 표시 폭 584에서 오른쪽 100 → 484(표시 폭보다 좁음 = 명시적 좁히기)
    fireEvent.pointerMove(thread, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerUp(thread, { clientX: 1000, pointerId: 1 });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('484px');
  });

  it('nextThreadIntent: 넓힘(결과 ≥ 표시)은 의도를 줄이지 않고, 좁힘은 그대로 저장', () => {
    expect(nextThreadIntent(772, 584, 584, 600)).toBe(772);
    expect(nextThreadIntent(772, 568, 584, 568)).toBe(568);
    expect(nextThreadIntent(400, 600, 400, 600)).toBe(600);
    expect(nextThreadIntent(null, 324, 324, 340)).toBeNull();
    expect(nextThreadIntent(null, 343, 327, 343)).toBe(343);
    expect(nextThreadIntent(null, 320, 327, 320)).toBe(320);
    // 방향은 자르기 전 요청값으로: 하한 320에 막힌 표시에서 → (요청 304)는 좁힘 → 320 저장(교차 검토 P3-B)
    expect(nextThreadIntent(772, 320, 320, 304)).toBe(320);
  });

  it('1300/772/260: → (좁히기) → 표시 폭 − 16 = 568이 의도로 저장되어 접어도 568', async () => {
    const { nav, thread } = await blocked772();
    fireEvent.keyDown(thread, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('568px');
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(thread.getAttribute('aria-valuenow')).toBe('568');
  });

  it('의도 null(기본 327 = ⌊32vw · jsdom innerWidth 1024⌋)에서 공간이 충분하면 ← 1회 → 의도 343', async () => {
    await wide(true);
    stubInner(() => 1416);
    fireEvent(window, new Event('resize'));
    const thread = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    fireEvent.keyDown(thread, { key: 'ArrowLeft' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('343px');
  });

  it('공간에 막힌 기본 상태(1040 → 표시 324)에서 ← → 의도 null 유지(기본 폭 그대로)', async () => {
    await wide(true);
    stubInner(() => 1040);
    fireEvent(window, new Event('resize'));
    const thread = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    // 1040 − 260 − 456 = 324 < 기본 327
    expect(thread.getAttribute('aria-valuenow')).toBe('324');
    fireEvent.keyDown(thread, { key: 'ArrowLeft' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('');
    fireEvent.keyDown(thread, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('');
  });
});

describe('방향 판정 보정(교차 검토 P3-A·P3-B)', () => {
  it('P3-A: 렌더 없이 연속 두 번 끌기(500 → 400, 의도 null·표시 327·공간 여유) → 의도 400', async () => {
    await wide(true);
    stubInner(() => 1416);
    fireEvent(window, new Event('resize'));
    const thread = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    expect(thread.getAttribute('aria-valuenow')).toBe('327');
    fireEvent.pointerDown(thread, { button: 0, clientX: 900, pointerId: 1 });
    // 한 act 안에서 두 번 이동 — 두 번째 핸들러는 첫 이동 전 렌더의 클로저(의도 null)를 본다.
    act(() => {
      fireEvent.pointerMove(thread, { clientX: 900 - 173, pointerId: 1 }); // 327 + 173 = 500
      fireEvent.pointerMove(thread, { clientX: 900 - 73, pointerId: 1 }); // 327 + 73 = 400
    });
    fireEvent.pointerUp(thread, { clientX: 827, pointerId: 1 });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('400px');
  });

  /** 1300·의도 772 → 안쪽 1000으로 줄임 → 공간 1000 − 260 − 456 = 284 < 320 → 표시는 하한 320에 막힌다. */
  async function pinnedAtMin() {
    await wide(true);
    stubInner(() => 1300);
    fireEvent(window, new Event('resize'));
    const nav = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    const thread = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    fireEvent.keyDown(nav, { key: 'Enter' });
    fireEvent.keyDown(thread, { key: 'End' });
    fireEvent.keyDown(nav, { key: 'Enter' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('772px');
    stubInner(() => 1000);
    fireEvent(window, new Event('resize'));
    expect(thread.getAttribute('aria-valuenow')).toBe('320');
    return thread;
  }

  function restoreRoom(thread: HTMLElement) {
    stubInner(() => 1300);
    fireEvent(window, new Event('resize'));
    expect(thread.getAttribute('aria-valuenow')).toBe('320');
  }

  it('P3-B: 표시가 320에 막힌 상태(의도 772)에서 → → 의도 320, 공간이 돌아와도 320', async () => {
    const thread = await pinnedAtMin();
    fireEvent.keyDown(thread, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('320px');
    restoreRoom(thread);
  });

  it('P3-B: 표시가 320에 막힌 상태(의도 772)에서 Home → 의도 320, 공간이 돌아와도 320', async () => {
    const thread = await pinnedAtMin();
    fireEvent.keyDown(thread, { key: 'Home' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('320px');
    restoreRoom(thread);
  });
});
