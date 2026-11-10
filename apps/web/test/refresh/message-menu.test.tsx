/**
 * R4 시안 메시지 메뉴(Floating-Menus A·B): 더보기 버튼·우클릭·Shift+F10으로 열고, ↑↓ 이동·Esc 닫기 후 포커스 복귀,
 * 수정·삭제는 내 메시지에만, 텍스트·링크 복사는 결과를 role=status로 알린다. 기대값은 리터럴.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageItem, type MessageItemData, type MessageItemProps } from '../../src/features/conversation/index.js';
import type { ActionResult } from '../../src/data/index.js';

const ok: ActionResult<null> = { ok: true, value: null };
const base: MessageItemData = { id: 'm1', author: 'A', createdAt: '2026-11-07T00:00:00Z', body: '원문 본문', authorId: 'me', replyCount: 0 };

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** userEvent.setup()이 자체 clipboard를 심으므로 렌더 직전(= setup 뒤)에 덮어쓴다. */
function renderItem({ noLink = false, ...props }: Partial<MessageItemProps> & { readonly noLink?: boolean } = {}) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(
    <ul>
      <MessageItem
        message={base}
        selfId="me"
        rovingActive
        onReply={vi.fn()}
        onEdit={vi.fn(async () => ok)}
        onDelete={vi.fn(async () => ok)}
        {...(noLink ? {} : { messageLink: (id: string) => `https://host/c/c1#message-${id}` })}
        {...props}
      />
    </ul>,
  );
  return screen.getByRole('listitem');
}

const itemNames = () => within(screen.getByRole('menu', { name: '메시지 메뉴' })).getAllByRole('menuitem').map((b) => b.textContent);

describe('더보기 메뉴', () => {
  it('내 메시지: 스레드로 답글 · 텍스트 복사 · 메시지 링크 복사 · 메시지 수정 · 메시지 삭제…, 첫 항목에 포커스', async () => {
    const user = userEvent.setup();
    renderItem();
    const more = screen.getByRole('button', { name: '더보기' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(itemNames()).toEqual(['스레드로 답글R', '텍스트 복사', '메시지 링크 복사', '메시지 수정E', '메시지 삭제…Del']);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '스레드로 답글' }));
  });

  it('다른 사람 메시지: 수정·삭제 없음, 링크 주소가 없으면 링크 복사도 없음', async () => {
    const user = userEvent.setup();
    renderItem({ message: { ...base, authorId: 'other' }, noLink: true });
    await user.click(screen.getByRole('button', { name: '더보기' }));
    expect(itemNames()).toEqual(['스레드로 답글R', '텍스트 복사']);
  });

  it('↑↓는 순환 이동, Esc는 닫고 더보기 버튼으로 포커스를 돌려준다', async () => {
    const user = userEvent.setup();
    renderItem();
    const more = screen.getByRole('button', { name: '더보기' });
    await user.click(more);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '메시지 삭제…' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '스레드로 답글' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('Home·End는 첫·마지막 항목, Enter는 선택(메뉴를 닫고 동작)', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '메시지 삭제…' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '스레드로 답글' }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(writeText).toHaveBeenCalledWith('원문 본문');
  });

  it('Tab은 메뉴를 닫고 더보기 버튼으로 포커스를 돌려준다, 다시 누르면 토글로 닫힌다', async () => {
    const user = userEvent.setup();
    renderItem();
    const more = screen.getByRole('button', { name: '더보기' });
    await user.click(more);
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    await user.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('항목은 role=menuitem·tabIndex -1(로빙), 단축키 표시는 aria-hidden', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    for (const item of screen.getAllByRole('menuitem')) expect(item.getAttribute('tabindex')).toBe('-1');
    const kbd = screen.getByRole('menuitem', { name: '메시지 수정' }).querySelector('kbd');
    expect(kbd?.getAttribute('aria-hidden')).toBe('true');
  });

  it('메뉴 안 키는 메시지 단축키(E·Delete)로 새지 않는다', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    await user.keyboard('e');
    expect(screen.queryByRole('textbox', { name: '수정' })).toBeNull();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('바깥을 누르면 닫힌다', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('「메시지 삭제…」 → 확인 Dialog', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    await user.click(screen.getByRole('menuitem', { name: '메시지 삭제…' }));
    expect(screen.getByRole('dialog', { name: '메시지 삭제' })).toBeTruthy();
  });
});

describe('항목에서 메뉴 열기', () => {
  it('우클릭 → 메뉴(브라우저 기본 메뉴 막음), 닫으면 포커스는 메시지 항목으로', async () => {
    const user = userEvent.setup();
    const li = renderItem();
    const notPrevented = fireEvent.contextMenu(li, { clientX: 40, clientY: 20 });
    expect(notPrevented).toBe(false);
    const menu = screen.getByRole('menu', { name: '메시지 메뉴' });
    expect(menu.dataset['at']).toBe('pointer');
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(li);
  });

  it('메시지 항목 포커스에서 Shift+F10 → 메뉴', async () => {
    const user = userEvent.setup();
    const li = renderItem();
    li.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu', { name: '메시지 메뉴' })).toBeTruthy();
  });

  it('ContextMenu 키도 메뉴를 열고, Esc로 닫으면 포커스는 메시지 항목으로', async () => {
    const user = userEvent.setup();
    const li = renderItem();
    li.focus();
    fireEvent.keyDown(li, { key: 'ContextMenu' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '스레드로 답글' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(li);
  });

  it('삭제된 메시지·전송 대기 메시지는 우클릭해도 메뉴가 없다(브라우저 기본 메뉴 그대로)', () => {
    const li = renderItem({ message: { ...base, deleted: true, body: '' } });
    expect(fireEvent.contextMenu(li)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('복사', () => {
  it('텍스트 복사 → 본문을 클립보드에 쓰고 「텍스트를 복사했습니다」를 잠깐 알린다', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    await user.click(screen.getByRole('menuitem', { name: '텍스트 복사' }));
    expect(writeText).toHaveBeenCalledWith('원문 본문');
    expect((await screen.findByRole('status')).textContent).toBe('텍스트를 복사했습니다');
  });

  it('메시지 링크 복사 → messageLink(id) 주소', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: '더보기' }));
    await user.click(screen.getByRole('menuitem', { name: '메시지 링크 복사' }));
    expect(writeText).toHaveBeenCalledWith('https://host/c/c1#message-m1');
    expect((await screen.findByRole('status')).textContent).toBe('링크를 복사했습니다');
  });

  it('클립보드 거부 → 「복사하지 못했습니다」, 1.6초 뒤 사라짐', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    renderItem();
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '텍스트 복사' }));
    });
    expect(screen.getByRole('status').textContent).toBe('복사하지 못했습니다');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
