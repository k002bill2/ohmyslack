/** 시안 08 / UI_STATES §3 「메시지 액션」: compact = 길게 누르기·「메시지 작업」 → 액션 시트, medium·wide = 인라인 툴바. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageItem, type MessageItemProps } from '../../src/features/conversation/index.js';
import { CANCEL_LABEL, DELETE_MESSAGE_COPY, MESSAGE_ACTION_COPY } from '../../src/ui/copy.js';

// jsdom에 PointerEvent가 없으면 fireEvent.pointer*가 일반 Event를 만들어 button·clientX가 빠진다 — 테스트에서만 보강.
beforeAll(() => {
  if (typeof window.PointerEvent === 'function') return;
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly isPrimary: boolean;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
      this.pointerType = init.pointerType ?? 'touch';
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ACTIONS = '메시지 작업';
const own = { id: 'm1', author: '나', createdAt: '2026-11-08T02:40:00Z', body: '첫 줄\n둘째 줄\n셋째 줄', authorId: 'u1' };

function renderItem(props: Partial<MessageItemProps> = {}, withReply = true) {
  const handlers = {
    ...(withReply ? { onReply: vi.fn() } : {}),
    onEdit: vi.fn(async () => ({ ok: true as const, value: null })),
    onDelete: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  const utils = render(
    <ul>
      <MessageItem message={own} selfId="u1" timePlacement="below" {...handlers} {...props} />
    </ul>,
  );
  const li = utils.container.querySelector<HTMLElement>('[data-message-id="m1"]');
  if (li === null) throw new Error('항목 없음');
  return { ...utils, li, handlers };
}

function body(li: HTMLElement): HTMLElement {
  const el = li.querySelector<HTMLElement>('.msg-body');
  if (el === null) throw new Error('본문 없음');
  return el;
}

function press(target: HTMLElement, x = 10, y = 10) {
  fireEvent.pointerDown(target, { clientX: x, clientY: y, button: 0, isPrimary: true, pointerId: 1 });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('compact 액션 시트 — 길게 누르기', () => {
  it('500ms 누르면 시트가 열리고 포커스는 항목으로 돌아올 자리', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    press(body(li));
    advance(499);
    expect(screen.queryByRole('dialog')).toBeNull();
    advance(1);
    const sheet = screen.getByRole('dialog', { name: ACTIONS });
    expect(sheet.querySelector('.msg-action-sheet')).not.toBeNull();
    // 미리보기: 작성자 + 본문(일반 텍스트).
    expect(sheet.querySelector('.msg-sheet-author')?.textContent).toBe('나');
    expect(sheet.querySelector('.msg-sheet-body')?.textContent).toBe(own.body);
    // 항목 순서: 답글 → 수정 → 삭제 → 취소.
    const names = within(sheet.querySelector<HTMLElement>('.msg-action-sheet') as HTMLElement)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['답글', MESSAGE_ACTION_COPY.edit, MESSAGE_ACTION_COPY.delete, CANCEL_LABEL]);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(li);
  });

  it('500ms 전에 손을 떼면 열리지 않는다', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    press(body(li));
    advance(300);
    fireEvent.pointerUp(body(li), { button: 0 });
    advance(500);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('10px 넘게 움직이면 취소(가로·세로), 10px 이내면 유지', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    press(body(li), 10, 10);
    fireEvent.pointerMove(body(li), { clientX: 25, clientY: 10 });
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
    press(body(li), 10, 10);
    fireEvent.pointerMove(body(li), { clientX: 10, clientY: 25 });
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
    press(body(li), 10, 10);
    fireEvent.pointerMove(body(li), { clientX: 15, clientY: 15 });
    advance(500);
    expect(screen.getByRole('dialog', { name: ACTIONS })).toBeTruthy();
  });

  it('pointercancel·pointerleave면 취소', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    press(body(li));
    fireEvent.pointerCancel(body(li));
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
    press(body(li));
    fireEvent.pointerLeave(li);
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('스크롤하면 취소', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    press(body(li));
    fireEvent.scroll(document.body);
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('보조 버튼·버튼 위에서 시작한 누르기는 무시', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    fireEvent.pointerDown(body(li), { clientX: 0, clientY: 0, button: 2, isPrimary: true });
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
    press(screen.getByRole('button', { name: ACTIONS }));
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('누르는 동안에만 contextmenu를 막는다', () => {
    vi.useFakeTimers();
    const { li } = renderItem();
    expect(fireEvent.contextMenu(body(li))).toBe(true);
    press(body(li));
    expect(fireEvent.contextMenu(body(li))).toBe(false);
    fireEvent.pointerUp(body(li));
    expect(fireEvent.contextMenu(body(li))).toBe(true);
  });
});

describe('compact 액션 시트 — 「메시지 작업」 버튼(키보드·스크린리더)', () => {
  it('인라인 툴바 없이 트리거만, 답글 가능하면 data-reply-for', () => {
    const { container } = renderItem();
    expect(container.querySelector('.msg-toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: '답글' })).toBeNull();
    const trigger = screen.getByRole('button', { name: ACTIONS });
    expect(trigger.getAttribute('data-reply-for')).toBe('m1');
  });

  it('답글이 없으면 data-reply-for 없음', () => {
    renderItem({}, false);
    expect(screen.getByRole('button', { name: ACTIONS }).hasAttribute('data-reply-for')).toBe(false);
  });

  it('Enter로 열고 취소하면 트리거로 포커스 복귀', async () => {
    const user = userEvent.setup();
    renderItem();
    const trigger = screen.getByRole('button', { name: ACTIONS });
    trigger.focus();
    await user.keyboard('{Enter}');
    const sheet = screen.getByRole('dialog', { name: ACTIONS });
    await user.click(within(sheet).getByRole('button', { name: CANCEL_LABEL }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('답글 → 시트 닫고 onReply', async () => {
    const user = userEvent.setup();
    const { handlers } = renderItem();
    await user.click(screen.getByRole('button', { name: ACTIONS }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '답글' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(handlers.onReply).toHaveBeenCalledWith('m1');
  });

  it('수정 → 시트 닫고 편집기에 포커스', async () => {
    const user = userEvent.setup();
    renderItem();
    await user.click(screen.getByRole('button', { name: ACTIONS }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: MESSAGE_ACTION_COPY.edit }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const editor = document.querySelector('.msg-editor textarea, .msg-editor input');
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
  });

  it('삭제 → 시트가 닫힌 뒤 삭제 확인 Dialog 하나만, 취소하면 트리거로 복귀', async () => {
    const user = userEvent.setup();
    renderItem();
    const trigger = screen.getByRole('button', { name: ACTIONS });
    await user.click(trigger);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: MESSAGE_ACTION_COPY.delete }));
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: DELETE_MESSAGE_COPY.title })).toBeTruthy();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: CANCEL_LABEL }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('남의 메시지는 수정·삭제 없이 답글·취소만', async () => {
    const user = userEvent.setup();
    renderItem({ selfId: 'u9' });
    await user.click(screen.getByRole('button', { name: ACTIONS }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).queryByRole('button', { name: MESSAGE_ACTION_COPY.edit })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: MESSAGE_ACTION_COPY.delete })).toBeNull();
    expect(within(sheet).getByRole('button', { name: '답글' })).toBeTruthy();
  });
});

describe('toolbar 모드(medium·wide) — 변화 없음', () => {
  it('timePlacement inline이면 인라인 답글·수정·삭제, 트리거 없음, 길게 눌러도 시트 없음', () => {
    vi.useFakeTimers();
    const { li, container } = renderItem({ timePlacement: 'inline' });
    expect(container.querySelector('.msg-toolbar')).not.toBeNull();
    expect(screen.getByRole('button', { name: '답글' }).getAttribute('data-reply-for')).toBe('m1');
    expect(screen.getByRole('button', { name: MESSAGE_ACTION_COPY.edit })).toBeTruthy();
    expect(screen.getByRole('button', { name: MESSAGE_ACTION_COPY.delete })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ACTIONS })).toBeNull();
    press(body(li));
    advance(600);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
