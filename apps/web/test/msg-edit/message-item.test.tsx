/** W-10i CMP-07 액션·인라인 수정·삭제 Dialog·CMP-14 상태(컴포넌트 단위). */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageItem, canModify, createPending, failureView, type MessageItemData, type MessageItemProps } from '../../src/features/conversation';
import { createMemoryHistory, parseThreadParam, withThread } from '../../src/app/route.js';
import type { ActionResult } from '../../src/data/index.js';
import { ERROR_COPY } from '../../src/ui/copy.js';

afterEach(cleanup);

const ME = 'me';
const base: MessageItemData = { id: 'm1', author: 'A', createdAt: '2026-11-07T00:00:00Z', body: '원문', authorId: ME, replyCount: 0 };
const ok: ActionResult<null> = { ok: true, value: null };

function renderItem(props: Partial<MessageItemProps> & { message?: MessageItemData } = {}) {
  const onEdit = vi.fn(async (): Promise<ActionResult<null>> => ok);
  const onDelete = vi.fn(async (): Promise<ActionResult<null>> => ok);
  const view = render(
    <ul>
      <MessageItem message={base} selfId={ME} onEdit={onEdit} onDelete={onDelete} {...props} />
    </ul>,
  );
  return { onEdit, onDelete, ...view };
}

const li = () => screen.getByRole('listitem');

describe('액션 노출 규칙', () => {
  it('본인 저장 확인 메시지 → 수정·삭제 노출', () => {
    renderItem();
    expect(within(li()).getByRole('button', { name: '수정' })).toBeTruthy();
    expect(within(li()).getByRole('button', { name: '삭제' })).toBeTruthy();
  });

  it('타인·삭제됨·전송 중·내 ID 모름 → 액션 없음', () => {
    expect(canModify({ authorId: 'other' }, ME)).toBe(false);
    expect(canModify({ authorId: ME, deleted: true }, ME)).toBe(false);
    expect(canModify({ authorId: ME }, undefined)).toBe(false);
    const pending = createPending({ conversationId: 'c', authorId: ME, clientMessageId: 'x', body: '본문', online: true });
    expect(canModify({ authorId: ME, pending }, ME)).toBe(false);
    renderItem({ message: { ...base, authorId: 'other' } });
    expect(within(li()).queryByRole('button', { name: '수정' })).toBeNull();
    expect(within(li()).queryByRole('button', { name: '삭제' })).toBeNull();
  });

  it('삭제됨 → 자리표시자(자리 유지)·액션 없음', () => {
    renderItem({ message: { ...base, body: '', deleted: true } });
    expect(within(li()).getByText('삭제된 메시지입니다')).toBeTruthy();
    expect(within(li()).queryByRole('button', { name: '수정' })).toBeNull();
  });
});

describe('인라인 수정', () => {
  const open = () => {
    fireEvent.click(within(li()).getByRole('button', { name: '수정' }));
    return within(li()).getByRole('textbox', { name: '수정' });
  };

  it('IME 조합 중 Enter는 저장하지 않고, 확정 Enter도 삼킨 뒤 다음 Enter에 저장', async () => {
    const { onEdit } = renderItem();
    const editor = open();
    fireEvent.change(editor, { target: { value: '한글' } });
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });
    expect(onEdit).toHaveBeenCalledWith('m1', '한글');
    expect(within(li()).queryByRole('textbox', { name: '수정' })).toBeNull();
  });

  it('Shift+Enter는 줄바꿈(저장 안 함), Esc는 취소 + 원문 유지', () => {
    const { onEdit } = renderItem();
    const editor = open();
    fireEvent.change(editor, { target: { value: '바꿈' } });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(onEdit).not.toHaveBeenCalled();
    expect(within(li()).getByText('원문')).toBeTruthy();
  });

  it('조합 중 Esc는 취소하지 않는다', () => {
    renderItem();
    const editor = open();
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Escape', keyCode: 229 });
    expect(within(li()).getByRole('textbox', { name: '수정' })).toBeTruthy();
  });

  it('바뀐 내용 없음·빈 본문은 요청하지 않는다', () => {
    const { onEdit } = renderItem();
    let editor = open();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();
    editor = open();
    fireEvent.change(editor, { target: { value: '   ' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('네트워크 실패 → ErrorState + 다시 시도(편집 유지), 403 → 재시도 없는 안내', async () => {
    const onEdit = vi
      .fn<() => Promise<ActionResult<null>>>()
      .mockResolvedValueOnce({ ok: false, status: 'network' })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    renderItem({ onEdit });
    const editor = open();
    fireEvent.change(editor, { target: { value: '새 본문' } });
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });
    expect(within(li()).getByRole('alert').textContent).toContain(ERROR_COPY.network);
    await act(async () => {
      fireEvent.click(within(li()).getByRole('button', { name: '다시 시도' }));
    });
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(within(li()).getByRole('alert').textContent).toContain(ERROR_COPY.notFound);
    expect(within(li()).queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(within(li()).getByRole('textbox', { name: '수정' })).toBeTruthy();
  });

  it('`edited_at` → 「(수정됨)」, 툴팁에 수정 시각', () => {
    renderItem({ message: { ...base, editedAt: '2026-11-07T00:01:00Z' } });
    expect(within(li()).getByText('(수정됨)').getAttribute('title')).toBe('2026-11-07T00:01:00Z');
  });
});

describe('삭제 확인 Dialog', () => {
  it('취소 → 요청 없음, 확인 → DELETE', async () => {
    const { onDelete } = renderItem();
    fireEvent.click(within(li()).getByRole('button', { name: '삭제' }));
    const dialog = screen.getByRole('dialog', { name: '메시지 삭제' });
    expect(within(dialog).getByText(/되돌릴 수 없습니다/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(li()).getByRole('button', { name: '삭제' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    });
    expect(onDelete).toHaveBeenCalledWith('m1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([403, 404])('%s → 재시도 불가 안내(삭제·다시 시도 버튼 없음)', async (status) => {
    renderItem({ onDelete: async () => ({ ok: false, status }) });
    fireEvent.click(within(li()).getByRole('button', { name: '삭제' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert').textContent).toContain(ERROR_COPY.notFound);
    expect(within(dialog).queryByRole('button', { name: '삭제' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it('5xx → 다시 시도 가능', async () => {
    renderItem({ onDelete: async () => ({ ok: false, status: 503 }) });
    fireEvent.click(within(li()).getByRole('button', { name: '삭제' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    });
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('failureView: 400·429·5xx 분류', () => {
    expect(failureView({ status: 400 })).toEqual({ text: ERROR_COPY.badRequest, retryable: false });
    expect(failureView({ status: 429 })).toEqual({ text: ERROR_COPY.rateLimited, retryable: true });
    expect(failureView({ status: 500 })).toEqual({ text: ERROR_COPY.server, retryable: true });
  });
});

describe('CMP-14 ThreadSummary 상태 4종', () => {
  const onOpenThread = () => undefined;

  it('숨김: 답글 0', () => {
    renderItem({ onOpenThread });
    expect(within(li()).queryByRole('button', { name: /^답글 \d/ })).toBeNull();
  });

  it('답글 수: 「답글 3」, 클릭 → 열기', () => {
    const open = vi.fn();
    renderItem({ message: { ...base, replyCount: 3 }, onOpenThread: open });
    fireEvent.click(within(li()).getByRole('button', { name: '답글 3' }));
    expect(open).toHaveBeenCalledWith('m1');
  });

  it('새 답글: 점 + 「새 답글」', () => {
    renderItem({ message: { ...base, replyCount: 2 }, onOpenThread, threadUnread: true });
    expect(within(li()).getByRole('button', { name: '답글 2 새 답글' })).toBeTruthy();
  });

  it('catch-up 보류: 새 답글 표시 갱신을 보류하고 끝나면 반영', () => {
    const view = renderItem({ message: { ...base, replyCount: 2 }, onOpenThread, threadUnread: false });
    const rerender = (unread: boolean, holding: boolean) =>
      view.rerender(
        <ul>
          <MessageItem message={{ ...base, replyCount: 2 }} selfId={ME} onOpenThread={onOpenThread} threadUnread={unread} threadHolding={holding} />
        </ul>,
      );
    rerender(true, true);
    expect(within(li()).queryByText('새 답글')).toBeNull();
    rerender(true, false);
    expect(within(li()).getByText('새 답글')).toBeTruthy();
  });

  it('삭제된 원문도 답글이 있으면 요약 유지', () => {
    renderItem({ message: { ...base, deleted: true, body: '', replyCount: 2 }, onOpenThread });
    expect(within(li()).getByRole('button', { name: '답글 2' })).toBeTruthy();
  });
});

describe('`?thread=` 경로', () => {
  it('parse·with·메모리 history 쿼리 분리', () => {
    expect(parseThreadParam('?thread=r1')).toBe('r1');
    expect(parseThreadParam('?thread=')).toBeNull();
    expect(parseThreadParam('')).toBeNull();
    expect(withThread('/c/x', 'r 1')).toBe('/c/x?thread=r+1');
    expect(parseThreadParam('?thread=r+1')).toBe('r 1');
    expect(withThread('/c/x', null)).toBe('/c/x');
    const h = createMemoryHistory('/c/x?thread=r1');
    expect(h.pathname()).toBe('/c/x');
    expect(h.search?.()).toBe('?thread=r1');
  });
});
