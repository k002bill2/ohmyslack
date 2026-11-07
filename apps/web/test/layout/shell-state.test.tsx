import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMemoryDataSource } from '../../src/data';
import { adjacentSpace, initialShellState, isSidebarCollapsed, shellReducer } from '../../src/features/layout';
import { UnreadBadge } from '../../src/features/sidebar';
import { T0, seed } from '../helpers/fixtures.js';
import { evaluate } from '../helpers/viewport.js';

describe('shellReducer (UI_STATES §3-3 T1–T4)', () => {
  it('스레드는 공간이 선택된 뒤에만 열리고, 공간을 바꾸면 닫힌다', () => {
    expect(shellReducer(initialShellState, { type: 'open-thread', rootId: 'm1' })).toBe(initialShellState);
    const s1 = shellReducer(initialShellState, { type: 'select-space', conversationId: 'c1' });
    const s2 = shellReducer(s1, { type: 'open-thread', rootId: 'm1' });
    expect(s2).toEqual({ conversationId: 'c1', threadRootId: 'm1' });
    expect(shellReducer(s2, { type: 'select-space', conversationId: 'c2' }).threadRootId).toBeNull();
    expect(shellReducer(s2, { type: 'close-thread' })).toEqual(s1);
    expect(shellReducer(s2, { type: 'back' })).toEqual(s1);
    expect(shellReducer(s1, { type: 'back' })).toEqual(initialShellState);
  });

  it('adjacentSpace는 순환하고 조건에 맞는 공간만 고르며 없으면 null', () => {
    const ids = ['a', 'b', 'c'];
    expect(adjacentSpace(ids, null, 1)).toBe('a');
    expect(adjacentSpace(ids, null, -1)).toBe('c');
    expect(adjacentSpace(ids, 'c', 1)).toBe('a');
    expect(adjacentSpace(ids, 'a', -1)).toBe('c');
    expect(adjacentSpace(ids, 'a', 1, (id) => id === 'c')).toBe('c');
    expect(adjacentSpace(ids, 'a', 1, () => false)).toBeNull();
    expect(adjacentSpace([], null, 1)).toBeNull();
  });

  it('isSidebarCollapsed는 wide + 스레드 열림 + 1120 미만에서만 참', () => {
    expect(isSidebarCollapsed({ breakpoint: 'wide', threadRoomy: false }, true)).toBe(true);
    expect(isSidebarCollapsed({ breakpoint: 'wide', threadRoomy: true }, true)).toBe(false);
    expect(isSidebarCollapsed({ breakpoint: 'wide', threadRoomy: false }, false)).toBe(false);
    expect(isSidebarCollapsed({ breakpoint: 'medium', threadRoomy: false }, true)).toBe(false);
  });

  it('matchMedia 목은 지원하지 않는 쿼리를 거부한다', () => {
    expect(() => evaluate('(min-width: 1px)', 10)).toThrow();
  });
});

describe('메모리 DataSource', () => {
  it('전송은 새 스냅숏을 만들고 원문 답글 수를 올리며 구독을 해지할 수 있다', () => {
    const ds = createMemoryDataSource(seed());
    const before = ds.getSnapshot();
    let calls = 0;
    const off = ds.subscribe(() => (calls += 1));
    ds.send({ conversationId: 'c1', rootId: 'm1' }, '새 답글');
    const after = ds.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.messages.find((m) => m.id === 'm1')?.replyCount).toBe(2);
    expect(after.messages.at(-1)).toMatchObject({ rootId: 'm1', body: '새 답글' });
    off();
    ds.send({ conversationId: 'c1' }, '원문');
    expect(calls).toBe(1);
    expect(ds.getSnapshot().messages.at(-1)?.rootId).toBeUndefined();
    expect(T0).toBeTruthy();
  });
});

describe('UnreadBadge (CMP-04)', () => {
  it('0이면 렌더하지 않고 99 초과는 99+로 표시한다', () => {
    const { container } = render(<UnreadBadge count={0} />);
    expect(container.innerHTML).toBe('');
    render(<UnreadBadge count={120} />);
    expect(screen.getByRole('img', { name: '멘션 120개' }).textContent).toBe('99+');
  });
});

describe('ThreadPanel Codex 지적 반영', () => {
  it('IME 조합 중 Esc는 닫지 않고, 다른 스레드를 열면 작성기 초안을 넘기지 않는다', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { ThreadPanel } = await import('../../src/features/thread');
    let closed = 0;
    const root = { id: 'm1', author: '홍길동', createdAt: T0, body: '원문' };
    const { rerender } = render(
      <ThreadPanel variant="medium" root={root} replies={[]} onClose={() => (closed += 1)} onSend={() => undefined} announce={() => undefined} />,
    );
    const box = screen.getByRole('textbox', { name: '답글' });
    fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 });
    expect(closed).toBe(0);
    fireEvent.change(box, { target: { value: 'A 초안' } });
    rerender(
      <ThreadPanel variant="medium" root={{ ...root, id: 'm2' }} replies={[]} onClose={() => (closed += 1)} onSend={() => undefined} announce={() => undefined} />,
    );
    expect((screen.getByRole('textbox', { name: '답글' }) as HTMLTextAreaElement).value).toBe('');
  });
});
