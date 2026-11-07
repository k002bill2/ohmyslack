/** W-10k B: 전송 버튼은 `.btn-primary` + 보이는 「전송」(접근 이름 「전송」 불변, UI_STATES §2-6·§4-4). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../../src/features/conversation/index.js';

afterEach(cleanup);

describe('Composer 전송 버튼(W-10k B)', () => {
  it('보이는 글자 「전송」과 btn-primary를 갖고 접근 이름은 「전송」 그대로다', () => {
    render(<Composer label="작성기" onSend={vi.fn()} />);
    const send = screen.getByRole('button', { name: '전송' });
    expect(send.textContent).toBe('전송');
    expect(send.classList.contains('btn')).toBe(true);
    expect(send.classList.contains('btn-primary')).toBe(true);
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('작성기 입력은 공통 .field 컨트롤을 쓴다', () => {
    render(<Composer label="작성기" onSend={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: '작성기' });
    expect(box.classList.contains('field')).toBe(true);
    fireEvent.change(box, { target: { value: '안녕' } });
    expect((screen.getByRole('button', { name: '전송' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
