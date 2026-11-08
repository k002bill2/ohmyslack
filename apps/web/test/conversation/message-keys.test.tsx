/**
 * D §7-3 「메시지에서 R / E / Delete」 + 메시지 단위 roving tabindex의 항목 쪽 계약(W-16 QA F-1).
 * - 단축키는 메시지 항목 자체에 포커스가 있을 때만(입력·버튼 안에서는 무시, D §7-3 「입력 중이 아닐 때만」).
 * - 물리 키(`code`) 기준: 한글 자판 상태(`key`가 「ㄱ」)여도 같은 키로 본다.
 * - 맥 키보드에는 Delete 키가 없어 Backspace도 삭제로 받는다(정본 Delete + 가정, QA_REPORT F-1).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageItem, type MessageItemData, type MessageItemProps } from '../../src/features/conversation';
import type { ActionResult } from '../../src/data/index.js';

afterEach(cleanup);

const ME = 'me';
const mine: MessageItemData = { id: 'm1', author: 'A', createdAt: '2026-11-07T00:00:00Z', body: '원문', authorId: ME, replyCount: 0 };
const ok: ActionResult<null> = { ok: true, value: null };

function renderItem(props: Partial<MessageItemProps> & { message?: MessageItemData } = {}) {
  const onReply = vi.fn();
  const onEdit = vi.fn(async (): Promise<ActionResult<null>> => ok);
  const onDelete = vi.fn(async (): Promise<ActionResult<null>> => ok);
  render(
    <ul>
      <MessageItem message={mine} selfId={ME} onReply={onReply} onEdit={onEdit} onDelete={onDelete} {...props} />
    </ul>,
  );
  const li = screen.getByRole('listitem');
  li.focus();
  return { li, onReply, onEdit, onDelete };
}

describe('FR-CLIENT-01 메시지 단축키(D §7-3)', () => {
  it('R → 답글(스레드 열기)', () => {
    const { li, onReply } = renderItem();
    fireEvent.keyDown(li, { key: 'r', code: 'KeyR' });
    expect(onReply).toHaveBeenCalledWith('m1');
  });

  it('한글 자판 상태(key 「ㄱ」)여도 물리 키 R이면 답글', () => {
    const { li, onReply } = renderItem();
    fireEvent.keyDown(li, { key: 'ㄱ', code: 'KeyR' });
    expect(onReply).toHaveBeenCalledWith('m1');
  });

  it('E → 내 메시지 인라인 편집기(본문이 채워진 입력에 포커스)', () => {
    const { li } = renderItem();
    fireEvent.keyDown(li, { key: 'e', code: 'KeyE' });
    const editor = within(li).getByRole('textbox');
    expect((editor as HTMLTextAreaElement).value).toBe('원문');
    expect(document.activeElement).toBe(editor);
  });

  it('Delete·Backspace → 내 메시지 삭제 확인 Dialog', () => {
    for (const key of ['Delete', 'Backspace']) {
      const { li } = renderItem();
      fireEvent.keyDown(li, { key, code: key });
      expect(screen.getByRole('dialog', { name: '메시지 삭제' })).toBeTruthy();
      cleanup();
    }
  });

  it('남의 메시지에서 E·Delete는 아무것도 하지 않고 R만 된다', () => {
    const { li, onReply } = renderItem({ message: { ...mine, authorId: 'other' } });
    fireEvent.keyDown(li, { key: 'e', code: 'KeyE' });
    fireEvent.keyDown(li, { key: 'Delete', code: 'Delete' });
    expect(within(li).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(li, { key: 'r', code: 'KeyR' });
    expect(onReply).toHaveBeenCalledOnce();
  });

  it('항목 안의 버튼에서, 수정키와 함께, IME 조합 중에는 무시한다', () => {
    const { li, onReply } = renderItem();
    const button = within(li).getByRole('button', { name: '답글' });
    fireEvent.keyDown(button, { key: 'r', code: 'KeyR' });
    fireEvent.keyDown(li, { key: 'r', code: 'KeyR', ctrlKey: true });
    fireEvent.keyDown(li, { key: 'r', code: 'KeyR', metaKey: true });
    fireEvent.keyDown(li, { key: 'Process', code: 'KeyR', keyCode: 229 });
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe('FR-CLIENT-01 roving 목록 이동 IME 보호', () => {
  it('조합 중(isComposing·229·Process) 화살표·Home·End는 이동하지 않고 기본 동작을 막지 않는다', async () => {
    const { useMessageRoving } = await import('../../src/features/conversation');
    const { useRef } = await import('react');
    function List() {
      const list = useRef<HTMLUListElement>(null);
      const r = useMessageRoving(list, ['a', 'b']);
      return (
        <ul ref={list} onKeyDown={r.onKeyDown}>
          <li data-message-id="a" tabIndex={-1}>a</li>
          <li data-message-id="b" tabIndex={0}>b</li>
        </ul>
      );
    }
    render(<List />);
    const [, b] = screen.getAllByRole('listitem') as [HTMLElement, HTMLElement];
    b.focus();
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { key: 'Process' }]) {
      for (const key of ['ArrowUp', 'Home']) {
        const notPrevented = fireEvent.keyDown(b, { key, ...init });
        expect(notPrevented).toBe(true);
        expect(document.activeElement).toBe(b);
      }
    }
    fireEvent.keyDown(b, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('a');
  });
});

describe('FR-CLIENT-01 roving tabindex 항목 계약', () => {
  it('활성 항목만 Tab 정류장(tabIndex 0)이고 안의 버튼도 활성일 때만 Tab으로 닿는다', () => {
    render(
      <ul>
        <MessageItem message={mine} selfId={ME} onReply={vi.fn()} rovingActive={false} />
        <MessageItem message={{ ...mine, id: 'm2' }} selfId={ME} onReply={vi.fn()} rovingActive />
      </ul>,
    );
    const [first, second] = screen.getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);
    expect(within(first).getByRole('button', { name: '답글' }).tabIndex).toBe(-1);
    expect(within(second).getByRole('button', { name: '답글' }).tabIndex).toBe(0);
  });

  it('rovingActive를 주지 않으면(스레드 패널 등) 기존처럼 항목은 tabIndex -1, 버튼은 그대로', () => {
    renderItem();
    const li = screen.getByRole('listitem');
    expect(li.tabIndex).toBe(-1);
    expect(within(li).getByRole('button', { name: '답글' }).tabIndex).toBe(0);
  });
});
