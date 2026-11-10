/**
 * 시안 01 스레드 요약 칩 강조: 지금 열린 스레드의 루트 칩만 강조(class + aria-current).
 * 「새 답글」(점 + 라벨)은 강조 조건과 분리돼 열림 여부와 상관없이 보인다.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { ThreadSummary } from '../../src/features/conversation';
import type { DataSource, Message, Snapshot, Space } from '../../src/data';
import { installViewport } from '../helpers/viewport.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AT = '2026-11-07T03:00:00.000Z';
const msg = (id: string, seq: number, replyCount: number): Message => ({
  id, conversationId: 'c1', author: '홍길동', createdAt: AT, body: `본문 ${id}`, replyCount, seq,
});
const space = (over: Partial<Space> = {}): Space => ({
  id: 'c1', kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0, ...over,
});

function source(snap: Snapshot): DataSource {
  return {
    getSnapshot: () => snap,
    subscribe: () => () => undefined,
    send: () => undefined,
  };
}

const chip = (id: string) => document.querySelector(`[data-thread-summary-for="${id}"]`) as HTMLElement;
const isActive = (el: HTMLElement) => el.classList.contains('thread-summary-active') && el.getAttribute('aria-current') === 'true';

describe('ThreadSummary 강조(컴포넌트)', () => {
  it('active → 강조 class + aria-current, 아니면 둘 다 없음', () => {
    const { rerender } = render(<ThreadSummary rootId="a" count={2} unread={false} holding={false} active onOpen={() => undefined} />);
    expect(isActive(chip('a'))).toBe(true);
    rerender(<ThreadSummary rootId="a" count={2} unread={false} holding={false} onOpen={() => undefined} />);
    expect(chip('a').classList.contains('thread-summary-active')).toBe(false);
    expect(chip('a').hasAttribute('aria-current')).toBe(false);
  });

  it('새 답글만 있으면 강조하지 않고 「새 답글」 표시는 유지', () => {
    render(<ThreadSummary rootId="a" count={2} unread holding={false} onOpen={() => undefined} />);
    expect(chip('a').classList.contains('thread-summary-active')).toBe(false);
    expect(chip('a').querySelector('.thread-summary-new')?.textContent).toBe('새 답글');
  });
});

describe('ThreadSummary 강조(AppShell 배선)', () => {
  it('스레드 열림 → 그 루트 칩만 강조, 닫힘 → 강조 없음. 「새 답글」은 그대로', async () => {
    installViewport(1440);
    const user = userEvent.setup();
    const ds = source({
      spaces: [space({ unreadThreadRoots: ['b'] })],
      messages: [msg('a', 1, 2), msg('b', 2, 1)],
      connection: 'connected',
    });
    render(<AppShell dataSource={ds} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    expect(isActive(chip('a'))).toBe(false);
    expect(isActive(chip('b'))).toBe(false);

    await user.click(chip('a'));
    expect(isActive(chip('a'))).toBe(true);
    expect(isActive(chip('b'))).toBe(false);
    expect(chip('b').querySelector('.thread-summary-new')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '스레드 패널 닫기' }));
    await act(async () => undefined);
    expect(document.querySelector('.thread-summary-active')).toBeNull();
    expect(document.querySelector('[data-thread-summary-for][aria-current]')).toBeNull();
  });
});
