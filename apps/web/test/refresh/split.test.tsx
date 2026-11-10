/**
 * R4 분할선(wide): 폭 계산(순수 함수)과 셸 통합(분할선 노출·Enter 접기/닫기·더블클릭 초기화·접기 버튼).
 * jsdom에는 레이아웃이 없어 폭 수치는 순수 함수로, 통합은 상태 전이로 본다. 기대값은 리터럴.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { dragNav, dragThread, navMax, threadMax } from '../../src/features/layout/split-math.js';
import { AppShell } from '../../src/features/layout/AppShell.js';
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

  it('스레드 상한 = min(560, 안쪽 − 24 − 480 − 내비)', () => {
    expect(threadMax(room)).toBe(560);
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
    expect(dragThread(900, room)).toBe(560);
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
