/**
 * R4 분할선(wide): 폭 계산(순수 함수)과 셸 통합(분할선 노출·Enter 접기/닫기·더블클릭 초기화·접기 버튼).
 * jsdom에는 레이아웃이 없어 폭 수치는 순수 함수로, 통합은 상태 전이로 본다. 기대값은 리터럴.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { dragNav, dragThread, navMax, threadMax } from '../../src/features/layout/split-math.js';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { clampToRoom } from '../../src/features/layout/useSplit.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

describe('분할 계산', () => {
  const room = { inner: 1416, nav: 260, thread: 372 };

  it('내비 상한 = min(360, 안쪽 − 12 − 480 − (스레드 + 12))', () => {
    expect(navMax(room)).toBe(360);
    expect(navMax({ inner: 1100, nav: 260, thread: 372 })).toBe(224);
    // 너무 좁으면 하한(200)을 상한으로 둔다.
    expect(navMax({ inner: 900, nav: 260, thread: 372 })).toBe(200);
    expect(navMax({ inner: 900, nav: 260, thread: null })).toBe(360);
  });

  it('스레드 상한 = 안쪽 − 24 − 480 − 내비 (고정 상한 없음)', () => {
    expect(threadMax(room)).toBe(652);
    // 넓은 창: 560을 넘어 공간 한계(1600 − 24 − 480 − 260 = 836)까지.
    expect(threadMax({ inner: 1600, nav: 260, thread: 372 })).toBe(836);
    // 내비를 레일(72)로 접으면 그만큼 늘어난다.
    expect(threadMax({ inner: 1600, nav: 72, thread: 372 })).toBe(1024);
    expect(threadMax({ inner: 1200, nav: 260, thread: 372 })).toBe(436);
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
    expect(dragThread(900, room)).toBe(652);
    expect(dragThread(2000, { inner: 1600, nav: 260, thread: 372 })).toBe(836);
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
    // 실측 스레드 = CSS가 줄인 표시 폭 320. 내비 상한 = min(360, 1096 − 12 − 480 − (320 + 12)) = 272
    const next = clampToRoom(base, { inner: 1096, nav: 300, thread: 320 });
    expect(next.threadW).toBe(560);
    expect(next.navW).toBe(272);
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
    // 의도 폭은 그대로, 표시 폭은 상한 1200 − 24 − 480 − 0 = 696.
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('1008px');
    expect(sep.getAttribute('aria-valuenow')).toBe('696');
    expect(sep.getAttribute('aria-valuemax')).toBe('696');
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
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('1096px');
    inner = 1000;
    fireEvent(window, new Event('resize'));
    // 표시 폭 = 상한 1000 − 24 − 480 = 496. → 한 칸 = 480.
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('480px');
  });

  it('셸 통합: 1100(자동 접힘) 구간으로 바로 줄여도 의도 폭은 320으로 떨어지지 않는다(QA N2)', async () => {
    await wide(true);
    let inner = 1416;
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => inner });
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('912px');
    inner = 1076;
    fireEvent(window, new Event('resize'));
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('912px');
    // 표시 폭 = min(912, 1076 − 24 − 480 − 0) = 572
    expect(sep.getAttribute('aria-valuenow')).toBe('572');
  });
});

describe('Home/End 큰 이동(P3-2, APG Window Splitter)', () => {
  it('스레드: Home = 320, End = 현재 상한', async () => {
    await wide(true);
    Object.defineProperty(shell(), 'clientWidth', { configurable: true, get: () => 1416 });
    const sep = screen.getByRole('separator', { name: /스레드 폭 조절/ });
    sep.focus();
    expect(fireEvent.keyDown(sep, { key: 'End' })).toBe(false);
    expect(shell()?.style.getPropertyValue('--thread-w')).toBe('912px');
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

  it('내비: 레일(사용자 접힘)에서 Home은 navMin으로 펼친다', async () => {
    await wide(false);
    const sep = screen.getByRole('separator', { name: /내비게이션 폭 조절/ });
    sep.focus();
    fireEvent.keyDown(sep, { key: 'Enter' });
    expect(shell()?.dataset['sidebar']).toBe('collapsed');
    fireEvent.keyDown(sep, { key: 'Home' });
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
