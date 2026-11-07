/** Codex r1: P1 스레드 원문 교체 시 편집 상태 초기화, P2 portal Dialog의 Tab을 스레드 트랩이 막지 않음. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../../src/features/thread';

afterEach(cleanup);

const msg = (id: string) => ({ id, author: 'A', createdAt: '2026-11-07T00:00:00Z', body: id, authorId: 'me' });
const ok = async () => ({ ok: true as const, value: null });

function panel(rootId: string) {
  return (
    <ThreadPanel
      variant="medium"
      root={msg(rootId)}
      replies={[]}
      onClose={() => undefined}
      onSend={() => undefined}
      announce={() => undefined}
      messageActions={{ selfId: 'me', onEdit: ok, onDelete: ok }}
    />
  );
}

describe('Codex r1', () => {
  it('P1: 원문이 바뀌면 편집기가 닫힌다', () => {
    const view = render(panel('a'));
    fireEvent.click(screen.getByRole('button', { name: '수정' }));
    expect(screen.getByRole('textbox', { name: '수정' })).toBeTruthy();
    view.rerender(panel('b'));
    expect(screen.queryByRole('textbox', { name: '수정' })).toBeNull();
  });

  it('P2: 삭제 Dialog 안 Tab은 스레드 포커스 트랩이 preventDefault하지 않는다', () => {
    render(panel('a'));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    const dialog = screen.getByRole('dialog', { name: '메시지 삭제' });
    const cancel = within(dialog).getByRole('button', { name: '취소' });
    cancel.focus();
    const notPrevented = fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(notPrevented).toBe(true);
  });
});
