/** W-10d(Codex r3 이월 P2): 실패 메시지 「다시 시도」·「삭제」가 전송 FSM(retry/discard)에 연결된다 — 본문·스레드. */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { writeCheckpoint } from '../../src/features/sync';
import { installViewport } from '../helpers/viewport.js';
import { CONV, ME, U, flush, message, setup } from '../sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(flush);
};

async function mount() {
  installViewport(1400);
  let id = 0;
  const ctx = setup({ newClientMessageId: () => U(900 + (id += 1)) });
  const posts: string[] = [];
  ctx.server.on(`POST /api/conversations/${CONV}/messages`, (_url, init) => {
    posts.push(String(init?.body));
    return { status: 500 };
  });
  ctx.server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1)], has_more: false } }));
  ctx.server.on(`GET /api/messages/${U(101)}/replies`, () => ({ status: 200, body: { root: message(1), replies: [], has_more: false } }));
  writeCheckpoint(ME, 3, ctx.storage);
  render(<AppShell dataSource={ctx.ds} />);
  await act(async () => {
    await ctx.ds.resume();
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'general' }));
  await settle();
  return { ...ctx, posts, user };
}

describe('실패 메시지 다시 시도·삭제 배선', () => {
  it('본문: 「전송 실패 · 다시 시도」는 같은 client_message_id로 다시 전송, 「삭제」는 대기 항목을 지운다', async () => {
    const { ds, posts, user } = await mount();
    await act(async () => ds.send({ conversationId: CONV }, 'hello'));
    await settle();
    expect(posts).toHaveLength(1);
    const pane = screen.getByRole('main');
    await user.click(within(pane).getByRole('button', { name: '전송 실패 · 다시 시도' }));
    await settle();
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1] ?? '{}').client_message_id).toBe(JSON.parse(posts[0] ?? '{}').client_message_id);
    await user.click(within(pane).getByRole('button', { name: '삭제' }));
    await settle();
    expect(within(pane).queryByText('hello')).toBeNull();
    expect(ds.getSnapshot().messages.some((m) => m.pending !== undefined)).toBe(false);
  });

  it('스레드: 답글 실패 항목의 「다시 시도」·「삭제」도 동작한다', async () => {
    const { ds, posts, user } = await mount();
    const trigger = document.querySelector<HTMLElement>(`[data-reply-for="${U(101)}"]`);
    if (trigger === null) throw new Error('답글 버튼 없음');
    await user.click(trigger);
    await settle();
    await act(async () => ds.send({ conversationId: CONV, rootId: U(101) }, 'reply'));
    await settle();
    const panel = screen.getByRole('complementary', { name: '스레드' });
    await user.click(within(panel).getByRole('button', { name: '전송 실패 · 다시 시도' }));
    await settle();
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1] ?? '{}').thread_root_id).toBe(U(101));
    await user.click(within(panel).getByRole('button', { name: '삭제' }));
    await settle();
    expect(within(panel).queryByText('reply')).toBeNull();
  });
});
