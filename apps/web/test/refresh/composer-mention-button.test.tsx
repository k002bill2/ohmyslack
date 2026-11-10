/**
 * R4 시안 작성기 아래 줄 `@` 버튼: 커서 자리에 `@`를 넣고 입력란으로 돌아가 멘션 후보(listbox)를 연다.
 * 기대값은 리터럴(상수 import 없음).
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/features/conversation/index.js';

afterEach(cleanup);

const CANDIDATES = [
  { id: 'u1', displayName: '나' },
  { id: 'u2', displayName: '김민지' },
];

function setup() {
  const user = userEvent.setup();
  render(<Composer label="입력" onSend={vi.fn()} mentions={{ candidates: CANDIDATES, selfId: 'u1' }} />);
  const box = screen.getByRole('textbox', { name: '입력' }) as HTMLTextAreaElement;
  return { user, box };
}

describe('작성기 「멘션 추가」 버튼', () => {
  it('빈 입력: `@`를 넣고 포커스를 입력란으로 돌려 후보 목록을 연다', async () => {
    const { user, box } = setup();
    await user.click(screen.getByRole('button', { name: '멘션 추가' }));
    expect(box.value).toBe('@');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '입력' }));
    expect(screen.getByRole('option', { name: '김민지' })).toBeTruthy();
  });

  it('글자 뒤: 공백 하나를 앞에 두고 `@`를 붙인다', async () => {
    const { user, box } = setup();
    await user.type(box, '안녕');
    await user.click(screen.getByRole('button', { name: '멘션 추가' }));
    expect(box.value).toBe('안녕 @');
  });

  it('멘션 후보가 없는 작성기(답글 등)에는 버튼이 없다', () => {
    render(<Composer label="답글" onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '멘션 추가' })).toBeNull();
  });
});
