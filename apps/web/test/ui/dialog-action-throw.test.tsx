/**
 * action-timeout Codex r1 P1: 파괴적 확인 Dialog의 확인 핸들러가 어떤 예외로 끝나도 busy가 풀리고
 * 기존 일반 실패 문구(ERROR_COPY.network)를 보인 뒤 Esc로 닫힌다 — busy 닫기 차단이 영구 잠금이 되지 않게.
 * 채널 나가기·봇 제거·메시지 삭제·멤버 비활성화 4곳 + 성공 헤더 뒤 본문 스트림 실패(실제 DataSource). 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionResult, DataSource } from '../../src/data/index.js';
import type { FetchLike } from '../../src/data/api.js';
import { LeaveChannelControl } from '../../src/features/conversation-membership/index.js';
import { DeleteMessageDialog } from '../../src/features/conversation/MessageItemDelete.js';
import { AppShell } from '../../src/features/layout';
import { MemberAdmin } from '../../src/features/members';
import { BOT_CHANNEL_COPY, DELETE_MESSAGE_COPY, ERROR_COPY, LEAVE_CHANNEL_COPY, MEMBER_DEACTIVATE_COPY } from '../../src/ui/copy.js';
import { BOT, fakeBotWorld } from '../conv-bots/fake-bots.js';
import { selectHeaderMenuItem } from '../conv-bots/header-menu.js';
import { ME, PEER, flush, setup } from '../sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

/** 분류 체계 밖 예외(NetworkError·HttpStatusError 아님). */
const boom = (): Promise<ActionResult<null>> => Promise.reject(new Error('unexpected'));

/** 실패 뒤: 일반 실패 문구, busy 해제, 취소 버튼 사용 가능, Esc로 닫힘. */
async function expectReleased(dialog: HTMLElement) {
  expect(within(dialog).getByRole('alert').textContent).toContain(ERROR_COPY.network);
  expect(dialog.hasAttribute('aria-busy')).toBe(false);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await settle();
  expect(dialog.isConnected).toBe(false);
}

function DeleteHost({ onConfirm }: { readonly onConfirm: () => Promise<ActionResult<null>> }) {
  const [open, setOpen] = useState(true);
  return open ? <DeleteMessageDialog onConfirm={onConfirm} onClose={() => setOpen(false)} onDeleted={() => setOpen(false)} /> : null;
}

async function confirmDelete(onConfirm: () => Promise<ActionResult<null>>) {
  render(<DeleteHost onConfirm={onConfirm} />);
  const dialog = screen.getByRole('dialog', { name: DELETE_MESSAGE_COPY.title });
  fireEvent.click(within(dialog).getByRole('button', { name: DELETE_MESSAGE_COPY.confirm }));
  await settle();
  return dialog;
}

describe('확인 핸들러 예외 → busy 해제(4곳)', () => {
  it('채널 나가기', async () => {
    render(<LeaveChannelControl onLeave={boom} />);
    fireEvent.click(screen.getByRole('button', { name: '채널 나가기' }));
    const dialog = screen.getByRole('dialog', { name: LEAVE_CHANNEL_COPY.title });
    fireEvent.click(within(dialog).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    await expectReleased(dialog);
  });

  it('봇 제거', async () => {
    const w = fakeBotWorld('owner');
    w.members.get('c1')?.add(BOT.id);
    const ds: DataSource = { ...w.ds, removeBotFromChannel: boom };
    render(<AppShell dataSource={ds} />);
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    screen.getByRole('button', { name: '대화 더보기' }).focus();
    selectHeaderMenuItem(BOT_CHANNEL_COPY.title(BOT.displayName));
    const dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) });
    fireEvent.click(within(dialog).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    await expectReleased(dialog);
  });

  it('메시지 삭제', async () => {
    await expectReleased(await confirmDelete(boom));
  });

  it('멤버 비활성화', async () => {
    const members = [
      { id: ME, displayName: 'A', role: 'owner' as const },
      { id: PEER, displayName: 'B', role: 'member' as const },
    ];
    render(
      <MemberAdmin
        account={{ id: ME, role: 'owner' }}
        load={async () => ({ ok: true, value: members })}
        createInvite={async () => ({ ok: false, status: 500 })}
        deactivate={boom}
        origin="https://h.test"
      />,
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'B 비활성화' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: MEMBER_DEACTIVATE_COPY.confirm }));
    await settle();
    await expectReleased(dialog);
  });
});

describe('메시지 삭제: 성공 헤더 뒤 본문 스트림 실패(실제 DataSource)', () => {
  it('오류 표시·busy 해제·Esc로 닫힘', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"message":'));
              c.error(new TypeError('network connection lost'));
            },
          }),
          { status: 200 },
        ),
      );
    const { ds } = setup({ fetch });
    const dialog = await confirmDelete(async () => (await ds.deleteMessage?.('m1')) ?? { ok: false, status: 'network' });
    await expectReleased(dialog);
  });
});
