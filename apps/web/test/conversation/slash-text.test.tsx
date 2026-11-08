/** FR-BOT-06 웹 측: 작성기는 `/`로 시작하는 입력을 가로채지 않는다(슬래시 명령 UI 없음), 승인 요청 안 명령 문구는 인라인 코드. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer, MessageBody } from '../../src/features/conversation/index.js';

afterEach(cleanup);

describe('FR-BOT-06 슬래시 원문', () => {
  it('FR-BOT-06 슬래시로 시작하는 owner 메시지는 작성기가 가로채지 않고 원문 그대로 전송·표시되며 승인 요청 안의 명령 문구는 인라인 코드로 보인다', () => {
    const onSend = vi.fn();
    render(<Composer label="작성기" onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: '작성기' });
    fireEvent.change(box, { target: { value: '/approve 42' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '전송' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('/approve 42');
    cleanup();

    const { container } = render(<MessageBody body="/approve 42" />);
    expect(container.textContent).toBe('/approve 42');
    expect(container.querySelector('code, a, strong')).toBeNull();
    cleanup();

    const approval = render(<MessageBody body={'**승인 요청** 배포 #42\n승인: `/approve 42` · 거절: `/deny 42`'} />);
    const codes = Array.from(approval.container.querySelectorAll('code.msg-inline-code')).map((c) => c.textContent);
    expect(codes).toEqual(['/approve 42', '/deny 42']);
  });

  it('FR-BOT-06 Enter로 보내도 슬래시 입력은 원문 그대로다', () => {
    const onSend = vi.fn();
    render(<Composer label="작성기" onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: '작성기' });
    fireEvent.change(box, { target: { value: '/deny 7 이유: 테스트 미통과' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/deny 7 이유: 테스트 미통과');
  });
});
