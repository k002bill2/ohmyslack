import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteAccept, type InviteAcceptProps, type InviteResult } from '../../src/features/auth/index.js';

afterEach(cleanup);

const TOKEN = 'tkn-fixture-abc123';
const EMAIL = 'n@b.c';
const PASS_INPUT = 'p1';
const UNUSABLE = '이 초대 링크는 더 이상 사용할 수 없습니다';
const LIMITED = '잠시 후 다시 시도해 주세요';
// UI_STATES §9 채택(COPY_GAPS G-06–G-13) 정본 문구를 허용 목록에 추가했다.
const TITLE = '초대 수락';
const INTRO = '계정을 만들면 바로 참여할 수 있습니다. 이메일·비밀번호·표시 이름을 입력해 주세요.';
const DN_HINT = '다른 멤버에게 보이는 이름입니다. 64자까지 입력할 수 있습니다.';
const PW_HINT = '12자 이상 128자 이하로 입력해 주세요.';
const PW_POLICY = '비밀번호 길이가 맞지 않습니다. 12자 이상 128자 이하로 입력해 주세요.';
const INVALID = '입력 내용을 처리할 수 없습니다. 이메일 형식과 표시 이름(1–64자)을 확인해 주세요.';
const NETWORK = '서버에 연결하지 못했습니다. 입력한 내용은 그대로 있으니 다시 시도해 주세요.';
const SERVER = '서버에 문제가 생겨 초대를 수락하지 못했습니다. 잠시 후 다시 시도해 주세요.';
const UNUSABLE_HINT = '이미 계정을 만들었다면 로그인해 주세요.';
const ALLOWED = [
  '이메일', '비밀번호', '수락', UNUSABLE, LIMITED,
  TITLE, INTRO, DN_HINT, PW_HINT, PW_POLICY, INVALID, NETWORK, SERVER, UNUSABLE_HINT, '로그인', '다시 시도',
];

function stripAllowed(text: string): string {
  return [...ALLOWED].sort((a, b) => b.length - a.length).reduce((acc, s) => acc.split(s).join(''), text).trim();
}

type AcceptFn = InviteAcceptProps['onAccept'];

function setup(onAccept: AcceptFn, hash = `#t=${TOKEN}`, extra: Partial<InviteAcceptProps> = {}) {
  const readHash = vi.fn(() => hash);
  const clearHash = vi.fn();
  const onSuccess = vi.fn();
  const view = render(
    <InviteAccept readHash={readHash} clearHash={clearHash} onAccept={onAccept} onSuccess={onSuccess} {...extra} />,
  );
  return { readHash, clearHash, onSuccess, view };
}

async function submit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('이메일'), EMAIL);
  await user.type(screen.getByLabelText('비밀번호'), PASS_INPUT);
  await user.click(screen.getByRole('button', { name: '수락' }));
}

describe('CMP-19 InviteAccept', () => {
  it('마운트 시 해시를 한 번 읽고 즉시 지우며 토큰을 DOM에 남기지 않는다', () => {
    const { readHash, clearHash } = setup(vi.fn());
    expect(readHash).toHaveBeenCalledTimes(1);
    expect(clearHash).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('수락 시 본문에 토큰·이메일·비밀번호를 보내고 2xx면 onSuccess를 부른다', async () => {
    const onAccept = vi.fn(async (): Promise<InviteResult> => ({ ok: true }));
    const user = userEvent.setup();
    const { onSuccess } = setup(onAccept);
    await submit(user);
    expect(onAccept).toHaveBeenCalledWith({ token: TOKEN, email: EMAIL, password: PASS_INPUT });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('displayNameLabel이 없으면 표시 이름 입력을 렌더하지 않는다', () => {
    setup(vi.fn());
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('displayNameLabel이 주어지면 표시 이름 입력을 렌더하고 display_name을 보낸다', async () => {
    const onAccept = vi.fn(async (): Promise<InviteResult> => ({ ok: true }));
    const user = userEvent.setup();
    setup(onAccept, `#t=${TOKEN}`, { displayNameLabel: 'DN' });
    await user.type(screen.getByLabelText('DN'), '길동');
    await submit(user);
    expect(onAccept).toHaveBeenCalledWith({ token: TOKEN, email: EMAIL, password: PASS_INPUT, display_name: '길동' });
  });

  it.each([404, 410, 409, 400, 403])('%i이면 사용 불가 문구를 보이고 폼을 숨긴다', async (status) => {
    const user = userEvent.setup();
    setup(async () => ({ ok: false, status }));
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(UNUSABLE);
    expect(screen.queryByRole('button', { name: '수락' })).toBeNull();
  });

  it.each(['', '#t=', '#x=abc'])('토큰이 없으면(%s) 사용 불가 문구를 보인다', (hash) => {
    const { clearHash } = setup(vi.fn(), hash);
    expect(screen.getByRole('alert').textContent).toBe(UNUSABLE);
    expect(screen.queryByRole('button', { name: '수락' })).toBeNull();
    expect(clearHash).toHaveBeenCalledTimes(1);
  });

  it('429면 제한 문구를 보이고 폼을 유지한다', async () => {
    const user = userEvent.setup();
    setup(async () => ({ ok: false, status: 429 }));
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(LIMITED);
    expect(screen.getByRole('button', { name: '수락' })).toBeTruthy();
  });

  it('네트워크 오류 후 재시도는 메모리의 같은 토큰을 쓴다(I-5)', async () => {
    const onAccept = vi.fn<AcceptFn>()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    const { onSuccess, readHash } = setup(onAccept);
    await submit(user);
    expect(onSuccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '수락' }));
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept.mock.calls[1]?.[0].token).toBe(TOKEN);
    expect(readHash).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('5xx는 사용 불가로 단정하지 않고 폼을 유지한다(G-12 ErrorState + 「다시 시도」)', async () => {
    const user = userEvent.setup();
    setup(async () => ({ ok: false, status: 503 }));
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(`${SERVER}다시 시도`);
    expect(screen.getByRole('button', { name: '수락' })).toBeTruthy();
  });

  it('정본 문구 외 텍스트를 렌더하지 않는다', async () => {
    const user = userEvent.setup();
    const { view } = setup(async () => ({ ok: false, status: 500 }));
    expect(stripAllowed(view.container.textContent ?? '')).toBe('');
    await submit(user);
    expect(stripAllowed(view.container.textContent ?? '')).toBe('');
  });
});

describe('CMP-19 InviteAccept 문구(COPY_GAPS G-06–G-13)', () => {
  it('G-06 제목·안내문, G-07 표시 이름 보조 문구, G-08 비밀번호 보조 문구를 aria-describedby로 잇는다', () => {
    setup(vi.fn(), `#t=${TOKEN}`, { displayNameLabel: '표시 이름' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(TITLE);
    expect(screen.getByText(INTRO)).toBeTruthy();
    const pw = screen.getByLabelText('비밀번호');
    expect(document.getElementById(pw.getAttribute('aria-describedby') ?? '')?.textContent).toBe(PW_HINT);
    const dn = screen.getByLabelText('표시 이름');
    expect(document.getElementById(dn.getAttribute('aria-describedby') ?? '')?.textContent).toBe(DN_HINT);
    expect(pw.getAttribute('aria-invalid')).toBeNull();
  });

  it('G-09 password_policy는 길이 안내를 alert로 보이고 비밀번호에 aria-invalid, 버튼 없음', async () => {
    const user = userEvent.setup();
    setup(async () => ({ ok: false, status: 400, code: 'password_policy' }));
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(PW_POLICY);
    expect(screen.getByLabelText('비밀번호').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(screen.getByRole('button', { name: '수락' })).toBeTruthy();
  });

  it('G-10 invalid_request는 입력 안내만 보이고 폼을 유지한다', async () => {
    const user = userEvent.setup();
    setup(async () => ({ ok: false, status: 400, code: 'invalid_request' }));
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(INVALID);
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it('G-11 네트워크 오류는 ErrorState + 「다시 시도」로 메모리의 같은 토큰을 다시 보낸다', async () => {
    const onAccept = vi.fn<AcceptFn>()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    const { onSuccess, view } = setup(onAccept);
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(`${NETWORK}다시 시도`);
    expect(stripAllowed(view.container.textContent ?? '')).toBe('');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onAccept).toHaveBeenNthCalledWith(2, { token: TOKEN, email: EMAIL, password: PASS_INPUT });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('G-13 사용할 수 없는 초대 아래 보조 안내와 /login 링크를 두고, 클릭하면 onGoLogin을 부른다', async () => {
    const onGoLogin = vi.fn();
    const user = userEvent.setup();
    const { view } = setup(async () => ({ ok: false, status: 400, code: 'invite_invalid' }), `#t=${TOKEN}`, { onGoLogin });
    await submit(user);
    expect(screen.getByRole('alert').textContent).toBe(UNUSABLE);
    expect(screen.getByText(UNUSABLE_HINT)).toBeTruthy();
    const link = screen.getByRole('link', { name: '로그인' });
    expect(link.getAttribute('href')).toBe('/login');
    await user.click(link);
    expect(onGoLogin).toHaveBeenCalledTimes(1);
    expect(stripAllowed(view.container.textContent ?? '')).toBe('');
  });

  it('G-13 onGoLogin이 없으면 링크는 기본 이동(href=/login)에 맡긴다', () => {
    setup(vi.fn(), '');
    const link = screen.getByRole('link', { name: '로그인' });
    expect(link.getAttribute('href')).toBe('/login');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
