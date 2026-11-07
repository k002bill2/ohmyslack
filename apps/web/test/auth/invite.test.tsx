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
const ALLOWED = ['이메일', '비밀번호', '수락', UNUSABLE, LIMITED];

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

  it('5xx는 사용 불가로 단정하지 않고 폼을 유지한다', async () => {
    const user = userEvent.setup();
    setup(async () => ({ ok: false, status: 503 }));
    await submit(user);
    expect(screen.queryByRole('alert')).toBeNull();
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
