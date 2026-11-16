/** 아직 서버에 저장되지 않은(pending) 메시지는 스레드 루트가 될 수 없다 — 임시 id(`pending:<cid>`)가 thread_root_id로 나가 400이 되고 답글이 사라졌다(2026-11-16 verify 실측). */
import { act, cleanup, render, screen } from '@testing-library/react';
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

describe('pending 루트에는 답글 동작이 없다', () => {
  it('전송 중·실패한 메시지에는 「스레드에 답글」 진입점이 없고, 저장된 메시지에는 있다', async () => {
    installViewport(1400);
    const ctx = setup({ newClientMessageId: () => U(901) });
    ctx.server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 500 }));
    ctx.server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1)], has_more: false } }));
    writeCheckpoint(ME, 3, ctx.storage);
    render(<AppShell dataSource={ctx.ds} />);
    await act(async () => {
      await ctx.ds.resume();
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'general' }));
    await settle();
    await act(async () => ctx.ds.send({ conversationId: CONV }, 'root-not-saved'));
    await settle();
    expect(ctx.ds.getSnapshot().messages.some((m) => m.id === `pending:${U(901)}`)).toBe(true);
    expect(document.querySelector(`[data-reply-for="pending:${U(901)}"]`)).toBeNull();
    expect(document.querySelector(`[data-reply-for="${U(101)}"]`)).not.toBeNull();
  });
});
