/**
 * R4 분할선(wide): 폭 계산(순수 함수)과 셸 통합(분할선 노출·Enter 접기/닫기·더블클릭 초기화·접기 버튼).
 * jsdom에는 레이아웃이 없어 폭 수치는 순수 함수로, 통합은 상태 전이로 본다. 기대값은 리터럴.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BODY_COLUMN_MIN, dragNav, dragThread, navMax, threadMax } from '../../src/features/layout/split-math.js';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { clampToRoom, type SplitState } from '../../src/features/layout/useSplit.js';
import { layoutVars, splitLimits, tokens } from '../../src/ui/tokens.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

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

  it('사이드바 「내비게이션 접기」 → 레일 + 「내비게이션 펼치기」로 복귀', async () => {
    const user = await wide(false);
    await user.click(screen.getByRole('button', { name: '내비게이션 접기' }));
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    await user.click(screen.getByRole('button', { name: '내비게이션 펼치기' }));
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

  it('셸 통합: 1600에서 1000으로 넓힌 뒤 1200으로 줄였다가 1600으로 되돌리면 다시 1000', async () => {
    await wide(true);
    // jsdom엔 레이아웃이 없다 — 셸 안쪽 폭만 심는다(내비·스레드 실측 폭은 0 → 표시 폭은 min(의도, 상한)으로 계산).
    let inner = 1600;
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => inner });
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'Home' });
    // 320에서 ← 한 칸 16px씩 넓혀 1000 근처(320 + 43 × 16 = 1008)까지.
    for (let i = 0; i < 43; i += 1) fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('1008px');
    inner = 1200;
    fireEvent(window, new Event('resize'));
    // 의도 폭은 그대로, 표시 폭은 상한 1200 − 24 − 432 − 0 = 744.
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('1008px');
    expect(sep.getAttribute('aria-valuenow')).toBe('744');
    expect(sep.getAttribute('aria-valuemax')).toBe('744');
    inner = 1600;
    fireEvent(window, new Event('resize'));
    expect(sep.getAttribute('aria-valuenow')).toBe('1008');
  });

  it('셸 통합: 의도 폭이 공간보다 클 때 → 는 표시 폭에서 한 칸 줄인다(먹통 아님)', async () => {
    await wide(true);
    let inner = 1600;
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => inner });
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('1144px');
    inner = 1000;
    fireEvent(window, new Event('resize'));
    // 표시 폭 = 상한 1000 − 24 − 432 = 544. → 한 칸 = 528.
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('528px');
  });

  it('셸 통합: 1100(자동 접힘) 구간으로 바로 줄여도 의도 폭은 320으로 떨어지지 않는다(QA N2)', async () => {
    await wide(true);
    let inner = 1416;
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => inner });
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('960px');
    inner = 1076;
    fireEvent(window, new Event('resize'));
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('960px');
    // 표시 폭 = min(960, 1076 − 24 − 432 − 0) = 620
    expect(sep.getAttribute('aria-valuenow')).toBe('620');
  });
});

describe('Home/End 큰 이동(P3-2, APG Window Splitter)', () => {
  it('스레드: Home = 320, End = 현재 상한', async () => {
    await wide(true);
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => 1416 });
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    expect(fireEvent.keyDown(sep, { key: 'End' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('960px');
    expect(fireEvent.keyDown(sep, { key: 'Home' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('320px');
  });

  it('내비: Home = 200(레일로 접지 않음), End = 현재 상한', async () => {
    await wide(false);
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => 1416 });
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
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => 1300 });
    fireEvent(window, new Event('resize'));
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    for (let i = 0; i < 30; i += 1) fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    const now = Number(sep.getAttribute('aria-valuenow'));
    const max = Number(sep.getAttribute('aria-valuemax'));
    expect(now).toBeLessThanOrEqual(max);
    expect(now).toBeGreaterThanOrEqual(Number(sep.getAttribute('aria-valuemin')));
    // clamp 전 값(의도 폭 그대로 = 320 + 30 × 16 = 800)이 상한 1300 − 456 = 844 안이므로 그대로 보인다.
    expect(now).toBe(800);
    expect(max).toBe(844);
  });
});
