import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginForm, type LoginResult } from '../../src/features/auth/index.js';

afterEach(cleanup);

const ALLOWED = ['이메일', '비밀번호', '로그인', '세션이 종료되었습니다. 다시 로그인해 주세요.', '잠시 후 다시 시도해 주세요'];
const EMAIL = 'a@b.c';
const PASS_INPUT = 'p1';

function stripAllowed(text: string): string {
  return [...ALLOWED].sort((a, b) => b.length - a.length).reduce((acc, s) => acc.split(s).join(''), text).trim();
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '로그인' }) as HTMLButtonElement;
}

async function fill(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('이메일'), EMAIL);
  await user.type(screen.getByLabelText('비밀번호'), PASS_INPUT);
  await user.click(submitButton());
}

describe('CMP-19 LoginForm', () => {
  it('2xx면 이메일·비밀번호로 onLogin을 부르고 onSuccess를 호출한다', async () => {
    const onLogin = vi.fn(async (): Promise<LoginResult> => ({ ok: true }));
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LoginForm onLogin={onLogin} onSuccess={onSuccess} />);
    await fill(user);
    expect(onLogin).toHaveBeenCalledWith(EMAIL, PASS_INPUT);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('429면 제한 문구를 role=alert로 보이고 onSuccess를 부르지 않는다', async () => {
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LoginForm onLogin={async () => ({ ok: false, status: 429 })} onSuccess={onSuccess} />);
    await fill(user);
    expect(screen.getByRole('alert').textContent).toBe('잠시 후 다시 시도해 주세요');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('자격 증명 오류(401)는 정본 문구가 없으므로 텍스트를 만들지 않고 폼을 유지한다', async () => {
    const user = userEvent.setup();
    const { container } = render(<LoginForm onLogin={async () => ({ ok: false, status: 401 })} onSuccess={() => {}} />);
    await fill(user);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stripAllowed(container.textContent ?? '')).toBe('');
    expect(submitButton().disabled).toBe(false);
  });

  it('429 이후 다른 실패가 오면 제한 문구를 지운다', async () => {
    const onLogin = vi.fn<(e: string, p: string) => Promise<LoginResult>>()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 401 });
    const user = userEvent.setup();
    render(<LoginForm onLogin={onLogin} onSuccess={() => {}} />);
    await fill(user);
    expect(screen.getByRole('alert')).toBeTruthy();
    await user.click(submitButton());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('네트워크 오류(throw)에도 폼을 유지하고 다시 제출할 수 있다', async () => {
    const onLogin = vi.fn<(e: string, p: string) => Promise<LoginResult>>()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ ok: true });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LoginForm onLogin={onLogin} onSuccess={onSuccess} />);
    await fill(user);
    expect(onSuccess).not.toHaveBeenCalled();
    await user.click(submitButton());
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('sessionEnded면 세션 종료 안내를 role=status로 보인다', () => {
    render(<LoginForm sessionEnded onLogin={async () => ({ ok: true })} onSuccess={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('세션이 종료되었습니다. 다시 로그인해 주세요.');
  });

  it('sessionEnded가 아니면 안내를 렌더하지 않는다', () => {
    render(<LoginForm onLogin={async () => ({ ok: true })} onSuccess={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('요청 중에는 제출 버튼을 비활성화하고 중복 제출하지 않는다', async () => {
    let resolve: (r: LoginResult) => void = () => {};
    const onLogin = vi.fn(() => new Promise<LoginResult>((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<LoginForm onLogin={onLogin} onSuccess={() => {}} />);
    await fill(user);
    expect(submitButton().disabled).toBe(true);
    await user.click(submitButton());
    expect(onLogin).toHaveBeenCalledTimes(1);
    resolve({ ok: false, status: 401 });
    await vi.waitFor(() => expect(submitButton().disabled).toBe(false));
  });

  it('정본 문구 외 텍스트를 렌더하지 않는다', () => {
    const { container } = render(<LoginForm sessionEnded onLogin={async () => ({ ok: true })} onSuccess={() => {}} />);
    expect(stripAllowed(container.textContent ?? '')).toBe('');
  });
});
