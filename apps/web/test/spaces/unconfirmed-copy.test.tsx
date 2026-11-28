/**
 * G-79 결과 미확인(timedOut) — 단정 접두(「…하지 못했습니다.」)와 결과 미확인 문장이 한 알림에 같이 나오지 않는다.
 * 지점: 첨부 업로드, 봇 추가, 기기 로그아웃. 비 timedOut(network·5xx)은 기존 「접두 + 원인」 그대로.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadErrorText } from '../../src/features/conversation/attachments/attachment-drafts.js';
import { SessionLogoutDialog } from '../../src/features/sessions/SessionLogoutDialog.js';
import { AppShell } from '../../src/features/layout';
import { failureText, prefixedFailureText } from '../../src/features/spaces';
import { ATTACHMENT_COPY, BOT_CHANNEL_COPY, ERROR_COPY, SESSION_LIST_COPY } from '../../src/ui/copy.js';
import { BOT, fakeBotWorld } from '../conv-bots/fake-bots.js';
import { selectHeaderMenuItem } from '../conv-bots/header-menu.js';
import { within } from '@testing-library/react';

afterEach(cleanup);

const TIMED_OUT = { status: 'network', timedOut: true } as const;
const NETWORK = { status: 'network' } as const;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
};

describe('prefixedFailureText', () => {
  it('timedOut이면 미확인 문장만, 아니면 「접두 + 원인」', () => {
    expect(prefixedFailureText('P.', 'U.', TIMED_OUT)).toBe('U.');
    expect(prefixedFailureText('P.', 'U.', NETWORK)).toBe(`P. ${ERROR_COPY.network}`);
    expect(prefixedFailureText('P.', 'U.', { status: 503 })).toBe(`P. ${ERROR_COPY.server}`);
  });
});

describe('첨부 업로드 (G-79)', () => {
  it('timedOut → 「업로드 결과를 확인하지 못했습니다.」만', () => {
    const t = uploadErrorText(TIMED_OUT, 'image');
    expect(t).toBe(ATTACHMENT_COPY.uploadUnconfirmed);
    expect(t).not.toContain(ATTACHMENT_COPY.uploadFailed);
  });
  it('network·5xx → 기존 문구 불변', () => {
    expect(uploadErrorText(NETWORK, 'image')).toBe(`${ATTACHMENT_COPY.uploadFailed} ${failureText(NETWORK)}`);
    expect(uploadErrorText({ status: 500 }, 'image')).toBe(`${ATTACHMENT_COPY.uploadFailed} ${failureText({ status: 500 })}`);
  });
});

describe('기기 로그아웃 Dialog (G-79)', () => {
  const show = (failure: Parameters<typeof SessionLogoutDialog>[0]['failure']) =>
    render(<SessionLogoutDialog label="X" busy={false} failure={failure} onConfirm={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
  it('timedOut → 「로그아웃 결과를 확인하지 못했습니다.」만', () => {
    show(TIMED_OUT);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toBe(SESSION_LIST_COPY.unconfirmed);
    expect(text).not.toContain(SESSION_LIST_COPY.failed);
  });
  it('network → 기존 「접두 + 원인」 불변', () => {
    show(NETWORK);
    expect(screen.getByRole('alert').textContent).toBe(`${SESSION_LIST_COPY.failed} ${ERROR_COPY.network}`);
  });
});

describe('봇 추가 (G-79)', () => {
  async function addWith(fail: { ok: false; status: 'network'; timedOut?: true }) {
    const w = fakeBotWorld('owner');
    w.fail.add = fail;
    render(<AppShell dataSource={w.ds} />);
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    selectHeaderMenuItem(BOT_CHANNEL_COPY.add(BOT.displayName));
    await settle();
    return screen.getByRole('alert').textContent ?? '';
  }
  it('timedOut → 「봇 추가 결과를 확인하지 못했습니다.」만', async () => {
    const text = await addWith({ ok: false, ...TIMED_OUT });
    expect(text).toBe(BOT_CHANNEL_COPY.addUnconfirmed);
    expect(text).not.toContain(BOT_CHANNEL_COPY.addFailed);
  });
  it('network → 기존 「접두 + 원인」 불변', async () => {
    expect(await addWith({ ok: false, ...NETWORK })).toBe(`${BOT_CHANNEL_COPY.addFailed} ${ERROR_COPY.network}`);
  });
});
