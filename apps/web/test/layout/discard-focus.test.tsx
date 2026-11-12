/**
 * a11y-focus-order 항목 2(WCAG 2.4.3): 실패 항목 「삭제」·「목록에서 지우기」 뒤 포커스가 body로 떨어지지 않는다.
 * 본문 → 본문 작성기(잠긴 DM은 안내), 스레드 → 스레드 작성기 → 스레드 안내 → 닫기. 다른 영역 포커스는 빼앗지 않는다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { writeCheckpoint } from '../../src/features/sync';
import { COMPOSER_COPY } from '../../src/ui/copy.js';
import { installViewport } from '../helpers/viewport.js';
import { CONV, ME, PEER, U, flush, message, setup, summary, type Reply } from '../sync/fake-server.js';

afterEach(cleanup);

const DM = U(11);
const ROOT = U(101);
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(flush);
};

/** 채널 general(원문 ROOT) + DM(상대 PEER). `post`가 두 대화의 전송 응답, `disabled`면 상대 비활성(잠긴 DM). */
async function mount(options: { readonly post: Reply; readonly disabled?: boolean }) {
  installViewport(1400);
  let id = 0;
  const ctx = setup({ newClientMessageId: () => U(900 + (id += 1)) });
  ctx.server.on('GET /api/conversations', () => ({
    status: 200,
    body: { conversations: [summary(), summary({ id: DM, kind: 'dm', name: null, peer_user_id: PEER })], next_cursor: null },
  }));
  const dmRoot = message(1, { conversation_id: DM, author_id: PEER, body: '예전 글' });
  ctx.server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1)], has_more: false } }));
  ctx.server.on(`GET /api/conversations/${DM}/messages`, () => ({ status: 200, body: { messages: [dmRoot], has_more: false } }));
  ctx.server.on(`GET /api/conversations/${DM}/members`, () => ({ status: 200, body: { members: [{ id: ME, display_name: 'A' }] } }));
  ctx.server.on(`GET /api/messages/${ROOT}/replies`, () => ({ status: 200, body: { root: message(1), replies: [], has_more: false } }));
  ctx.server.on('GET /api/users/names', () => ({
    status: 200,
    body: { users: options.disabled === true ? [{ id: PEER, display_name: '떠난이', status: 'disabled', kind: 'human' }] : [] },
  }));
  ctx.server.on(`POST /api/conversations/${CONV}/messages`, () => options.post);
  ctx.server.on(`POST /api/conversations/${DM}/messages`, () => options.post);
  writeCheckpoint(ME, 3, ctx.storage);
  render(<AppShell dataSource={ctx.ds} />);
  await act(async () => {
    await ctx.ds.resume();
  });
  await settle();
  return { ...ctx, user: userEvent.setup() };
}

type User = Awaited<ReturnType<typeof mount>>['user'];

async function open(user: User, name: string) {
  await user.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name }));
  await settle();
  return screen.getByRole('main');
}

async function openThread(user: User) {
  const trigger = document.querySelector<HTMLElement>(`[data-reply-for="${ROOT}"]`);
  if (trigger === null) throw new Error('답글 버튼 없음');
  await user.click(trigger);
  await settle();
  return screen.getByRole('complementary', { name: '스레드' });
}

/** 버튼에 포커스를 두고 Enter(QA 재현 그대로). */
async function press(user: User, button: HTMLElement) {
  button.focus();
  await user.keyboard('{Enter}');
  await settle();
}

describe('실패 항목 지운 뒤 포커스', () => {
  it('채널 본문 「삭제」 → 본문 작성기', async () => {
    const { user } = await mount({ post: { status: 500 } });
    const pane = await open(user, 'general');
    const box = within(pane).getByRole('textbox', { name: '#general에 메시지 작성' });
    await user.type(box, '안녕{Enter}');
    await settle();
    await press(user, within(pane).getByRole('button', { name: '삭제' }));
    expect(within(pane).queryByText('안녕')).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('채널 본문 「목록에서 지우기」(확인 안 됨) → 본문 작성기', async () => {
    const { user } = await mount({ post: 'network' });
    const pane = await open(user, 'general');
    const box = within(pane).getByRole('textbox', { name: '#general에 메시지 작성' });
    await user.type(box, '안녕{Enter}');
    await settle();
    await press(user, within(pane).getByRole('button', { name: '목록에서 지우기' }));
    expect(within(pane).queryByText('안녕')).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('활성 DM 스레드 「삭제」 → 스레드 작성기(본문 작성기가 가져가지 않음)', async () => {
    const { user } = await mount({ post: { status: 500 } });
    await open(user, 'general');
    const panel = await openThread(user);
    const reply = within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel });
    await user.type(reply, '답글{Enter}');
    await settle();
    await press(user, within(panel).getByRole('button', { name: '삭제' }));
    expect(within(panel).queryByText('답글')).toBeNull();
    expect(document.activeElement).toBe(reply);
  });

  it('잠긴 DM 본문 「삭제」 → 본문 안내(role=status)', async () => {
    const { user } = await mount({ post: { status: 403, body: { error: 'forbidden' } }, disabled: true });
    const pane = await open(user, 'B');
    await user.type(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' }), '안녕{Enter}');
    await settle();
    await press(user, within(pane).getByRole('button', { name: '삭제' }));
    expect(within(pane).queryByText('안녕')).toBeNull();
    expect(document.activeElement?.className).toBe('composer-notice');
    expect(pane.contains(document.activeElement)).toBe(true);
  });

  it('잠긴 DM 스레드 「삭제」 → 스레드 안내', async () => {
    const { user } = await mount({ post: { status: 403, body: { error: 'forbidden' } }, disabled: true });
    await open(user, 'B');
    const trigger = document.querySelector<HTMLElement>(`[data-reply-for="${U(101)}"]`);
    if (trigger === null) throw new Error('답글 버튼 없음');
    await user.click(trigger);
    await settle();
    const panel = screen.getByRole('complementary', { name: '스레드' });
    await user.type(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), '답글{Enter}');
    await settle();
    await press(user, within(panel).getByRole('button', { name: '삭제' }));
    expect(within(panel).queryByText('답글')).toBeNull();
    expect(document.activeElement?.className).toBe('composer-notice');
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('포커스가 영역 밖(사이드바)에 있으면 빼앗지 않는다', async () => {
    const { user } = await mount({ post: { status: 500 } });
    const pane = await open(user, 'general');
    await user.type(within(pane).getByRole('textbox', { name: '#general에 메시지 작성' }), '안녕{Enter}');
    await settle();
    const side = within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' });
    side.focus();
    fireEvent.click(within(pane).getByRole('button', { name: '삭제' }));
    await settle();
    expect(within(pane).queryByText('안녕')).toBeNull();
    expect(document.activeElement).toBe(side);
  });
});
