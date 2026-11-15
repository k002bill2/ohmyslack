import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginForm, type LoginResult } from '../../src/features/auth/index.js';

afterEach(cleanup);

// UI_STATES §9 채택(COPY_GAPS G-01–G-05) 정본 문구를 허용 목록에 추가했다.
const CREDENTIALS = '로그인할 수 없습니다. 이메일과 비밀번호를 확인해 주세요.';
const NETWORK = '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.';
const SERVER = '서버에 문제가 생겨 로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
const INVALID = '입력 형식을 처리할 수 없습니다. 이메일 주소를 확인해 주세요.';
// G-05 개정(시안 R5): 안내문은 개인 메신저 성격, 「초대로만」 안내는 카드 아래 G-73 줄이 맡는다.
const INTRO = '본인 기기에서만 접속하는 개인 메신저입니다.';
const INVITE_ONLY = '계정은 관리자가 보낸 초대 링크로만 만들 수 있습니다.';
const ALLOWED = [
  '이메일', '비밀번호', '로그인', '세션이 종료되었습니다. 다시 로그인해 주세요.', '잠시 후 다시 시도해 주세요',
  INTRO, INVITE_ONLY, CREDENTIALS, NETWORK, SERVER, INVALID, '다시 시도',
];
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

  it.each([401, 403, 404])('G-01 자격 증명 오류(%i)는 원인을 구분하지 않는 문구를 role=alert로 보이고 폼을 유지한다', async (status) => {
    const user = userEvent.setup();
    const { container } = render(<LoginForm onLogin={async () => ({ ok: false, status })} onSuccess={() => {}} />);
    await fill(user);
    expect(screen.getByRole('alert').textContent).toBe(CREDENTIALS);
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
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
    expect(screen.getByRole('alert').textContent).toBe('잠시 후 다시 시도해 주세요');
    await user.click(submitButton());
    expect(screen.queryByText('잠시 후 다시 시도해 주세요')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(CREDENTIALS);
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

describe('CMP-19 LoginForm 문구(COPY_GAPS G-02–G-05)', () => {
  it('G-05 제목 h1 「로그인」과 안내문을 보인다', () => {
    render(<LoginForm onLogin={async () => ({ ok: true })} onSuccess={() => {}} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('로그인');
    expect(screen.getByText(INTRO)).toBeTruthy();
  });

  it('G-73 카드 아래 구분선 영역에 「초대 링크로만」 안내를 보이고 이메일 예시 placeholder를 둔다', () => {
    const { container } = render(<LoginForm onLogin={async () => ({ ok: true })} onSuccess={() => {}} />);
    expect(container.querySelector('.auth-foot')?.textContent).toBe(INVITE_ONLY);
    expect(screen.getByLabelText('이메일').getAttribute('placeholder')).toBe('name@example.com');
  });

  it('G-04 400은 입력 형식 안내만 보이고 「다시 시도」 버튼은 없다', async () => {
    const user = userEvent.setup();
    render(<LoginForm onLogin={async () => ({ ok: false, status: 400 })} onSuccess={() => {}} />);
    await fill(user);
    expect(screen.getByRole('alert').textContent).toBe(INVALID);
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it.each([
    ['G-02 네트워크 오류', NETWORK, () => Promise.reject(new Error('net'))],
    ['G-03 5xx', SERVER, () => Promise.resolve({ ok: false, status: 503 } as LoginResult)],
  ] as const)('%s는 ErrorState 문구 + 「다시 시도」로 같은 입력을 다시 보낸다', async (_name, text, first) => {
    const onLogin = vi.fn<(e: string, p: string) => Promise<LoginResult>>()
      .mockImplementationOnce(first)
      .mockResolvedValueOnce({ ok: true });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<LoginForm onLogin={onLogin} onSuccess={onSuccess} />);
    await fill(user);
    expect(screen.getByRole('alert').textContent).toBe(`${text}다시 시도`);
    expect(stripAllowed(container.textContent ?? '')).toBe('');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onLogin).toHaveBeenNthCalledWith(2, EMAIL, PASS_INPUT);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
