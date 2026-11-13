/**
 * action-timeout C2: 파괴적 확인 Dialog는 요청 중(busy) Esc·「닫기」·「취소」·BODY 포커스 Esc로 닫히지 않는다.
 * 응답이 오면 기존대로 — 성공은 닫힘, 실패·시간 초과는 오류 표시 뒤 Esc로 닫힘(PR 26 QA §4-1: 닫아도 요청은 취소되지 않음).
 * 채널 나가기·봇 제거·메시지 삭제·멤버 비활성화 4곳. 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionResult, DataSource } from '../../src/data/index.js';
import { LeaveChannelControl } from '../../src/features/conversation-membership/index.js';
import { DeleteMessageDialog } from '../../src/features/conversation/MessageItemDelete.js';
import { AppShell } from '../../src/features/layout';
import { MemberAdmin } from '../../src/features/members';
import { BOT_CHANNEL_COPY, CANCEL_LABEL, DELETE_MESSAGE_COPY, DIALOG_CLOSE_LABEL, ERROR_COPY, LEAVE_CHANNEL_COPY, MEMBER_DEACTIVATE_COPY } from '../../src/ui/copy.js';
import { BOT, fakeBotWorld } from '../conv-bots/fake-bots.js';
import { selectHeaderMenuItem } from '../conv-bots/header-menu.js';
import { ME, PEER, flush } from '../sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const TIMED_OUT: ActionResult<null> = { ok: false, status: 'network', timedOut: true };

/** 요청 중: 네 가지 닫기 경로가 모두 막히고 상자는 aria-busy. */
async function expectBlocked(dialog: HTMLElement) {
  expect(dialog.getAttribute('aria-busy')).toBe('true');
  fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
  expect(dialog.isConnected).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(dialog.isConnected).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: DIALOG_CLOSE_LABEL }));
  expect(dialog.isConnected).toBe(true);
  const cancel = within(dialog).getByRole('button', { name: CANCEL_LABEL });
  expect((cancel as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(cancel);
  expect(dialog.isConnected).toBe(true);
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: 'Escape' });
  await settle();
  expect(dialog.isConnected).toBe(true);
  expect(screen.getByRole('dialog')).toBe(dialog);
}

/** 실패·시간 초과 뒤: 오류 표시, busy 해제, Esc로 닫힘. */
async function expectFailedThenClosable(dialog: HTMLElement, text: string) {
  expect(within(dialog).getByRole('alert').textContent).toContain(text);
  expect(dialog.hasAttribute('aria-busy')).toBe(false);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await settle();
  expect(dialog.isConnected).toBe(false);
}

describe('채널 나가기 — 요청 중 닫기 차단', () => {
  async function open() {
    const pending = deferred<ActionResult<null>>();
    render(<LeaveChannelControl onLeave={() => pending.promise} />);
    fireEvent.click(screen.getByRole('button', { name: '채널 나가기' }));
    const dialog = screen.getByRole('dialog', { name: LEAVE_CHANNEL_COPY.title });
    fireEvent.click(within(dialog).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    return { dialog, pending };
  }

  it('요청 중 Esc·닫기·취소·BODY Esc → 유지, 성공 → 닫힘', async () => {
    const { dialog, pending } = await open();
    await expectBlocked(dialog);
    pending.resolve({ ok: true, value: null });
    await settle();
    expect(dialog.isConnected).toBe(false);
  });

  it('시간 초과 → ERROR_COPY.timeout 표시 후 Esc로 닫힘', async () => {
    const { dialog, pending } = await open();
    await expectBlocked(dialog);
    pending.resolve(TIMED_OUT);
    await settle();
    await expectFailedThenClosable(dialog, ERROR_COPY.timeout);
  });
});

describe('봇 제거 — 요청 중 닫기 차단', () => {
  async function open() {
    const w = fakeBotWorld('owner');
    w.members.get('c1')?.add(BOT.id);
    const pending = deferred<ActionResult<null>>();
    const ds: DataSource = { ...w.ds, removeBotFromChannel: () => pending.promise };
    render(<AppShell dataSource={ds} />);
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    screen.getByRole('button', { name: '대화 더보기' }).focus();
    selectHeaderMenuItem(BOT_CHANNEL_COPY.title(BOT.displayName));
    const dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) });
    fireEvent.click(within(dialog).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    return { dialog, pending };
  }

  it('요청 중 유지, 성공 → 닫힘', async () => {
    const { dialog, pending } = await open();
    await expectBlocked(dialog);
    pending.resolve({ ok: true, value: null });
    await settle();
    expect(dialog.isConnected).toBe(false);
  });

  it('시간 초과 → 오류 표시 후 Esc로 닫힘', async () => {
    const { dialog, pending } = await open();
    await expectBlocked(dialog);
    pending.resolve(TIMED_OUT);
    await settle();
    await expectFailedThenClosable(dialog, ERROR_COPY.timeout);
  });
});

describe('메시지 삭제 — 요청 중 닫기 차단', () => {
  function Host({ result }: { readonly result: Promise<ActionResult<null>> }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          열기
        </button>
        {open && <DeleteMessageDialog onConfirm={() => result} onClose={() => setOpen(false)} onDeleted={() => setOpen(false)} />}
      </>
    );
  }

  async function open() {
    const pending = deferred<ActionResult<null>>();
    render(<Host result={pending.promise} />);
    const trigger = screen.getByRole('button', { name: '열기' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: DELETE_MESSAGE_COPY.title });
    fireEvent.click(within(dialog).getByRole('button', { name: DELETE_MESSAGE_COPY.confirm }));
    await settle();
    return { dialog, pending, trigger };
  }

  it('요청 중 유지, 성공 → 닫힘·트리거 복귀', async () => {
    const { dialog, pending, trigger } = await open();
    await expectBlocked(dialog);
    pending.resolve({ ok: true, value: null });
    await settle();
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('시간 초과 → 오류 표시 후 Esc로 닫힘', async () => {
    const { dialog, pending, trigger } = await open();
    await expectBlocked(dialog);
    pending.resolve(TIMED_OUT);
    await settle();
    await expectFailedThenClosable(dialog, ERROR_COPY.timeout);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('멤버 비활성화 — 요청 중 닫기 차단', () => {
  async function open() {
    const pending = deferred<ActionResult<null>>();
    const members = [
      { id: ME, displayName: 'A', role: 'owner' as const },
      { id: PEER, displayName: 'B', role: 'member' as const },
    ];
    render(
      <MemberAdmin
        account={{ id: ME, role: 'owner' }}
        load={async () => ({ ok: true, value: members })}
        createInvite={async () => ({ ok: false, status: 500 })}
        deactivate={() => pending.promise}
        origin="https://h.test"
      />,
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'B 비활성화' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: MEMBER_DEACTIVATE_COPY.confirm }));
    await settle();
    return { dialog, pending };
  }

  it('요청 중 유지, 성공 → 닫힘', async () => {
    const { dialog, pending } = await open();
    await expectBlocked(dialog);
    pending.resolve({ ok: true, value: null });
    await settle();
    expect(dialog.isConnected).toBe(false);
  });

  it('시간 초과 → 오류 표시 후 Esc로 닫힘', async () => {
    const { dialog, pending } = await open();
    await expectBlocked(dialog);
    pending.resolve(TIMED_OUT);
    await settle();
    await expectFailedThenClosable(dialog, ERROR_COPY.timeout);
  });
});
