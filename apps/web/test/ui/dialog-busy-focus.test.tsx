/**
 * dialog-busy-focus: 확인 Dialog의 확인 버튼이 요청 중 `disabled`로 바뀌거나 사라져도 포커스가 BODY로 빠지지 않는다.
 * 포커스가 Dialog 상자에 남아 있어야 Esc(상자 `onKeyDown`)·Tab 트랩이 닿는다(WCAG 2.1.2·2.4.3).
 * 채널 나가기·봇 제거·메시지 삭제 3곳 — 요청 중·실패 뒤 activeElement가 Dialog 안, Esc로 닫힘·트리거 복귀.
 * 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import type { ActionResult, DataSource } from '../../src/data/index.js';
import { DeleteMessageDialog } from '../../src/features/conversation/MessageItemDelete.js';
import { AppShell } from '../../src/features/layout';
import { Dialog } from '../../src/ui/Dialog.js';
import { BOT_CHANNEL_COPY, DELETE_MESSAGE_COPY, LEAVE_CHANNEL_COPY } from '../../src/ui/copy.js';
import { BOT, fakeBotWorld } from '../conv-bots/fake-bots.js';
import { selectHeaderMenuItem } from '../conv-bots/header-menu.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, flush, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 확인 버튼에 포커스를 두고(키보드 사용자) 누른다. */
async function pressConfirm(dialog: HTMLElement, name: string) {
  const confirm = within(dialog).getByRole('button', { name });
  confirm.focus();
  expect(document.activeElement).toBe(confirm);
  fireEvent.click(confirm);
  await settle();
  return confirm;
}

function expectFocusInside(dialog: HTMLElement) {
  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(dialog.contains(active)).toBe(true);
  expect((active as HTMLElement).matches(':disabled')).toBe(false);
}

const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('Dialog 공통 — 안 포커스 요소가 disabled·제거되면 상자로', () => {
  function Harness({ mode }: { readonly mode: 'disable' | 'remove' }) {
    const [open, setOpen] = useState(true);
    const [busy, setBusy] = useState(false);
    return (
      <>
        <button type="button">밖</button>
        {open && (
          <Dialog title="확인" onClose={() => setOpen(false)}>
            <button type="button">취소</button>
            {!(mode === 'remove' && busy) && (
              <button type="button" disabled={mode === 'disable' && busy} onClick={() => setBusy(true)}>
                확인
              </button>
            )}
          </Dialog>
        )}
      </>
    );
  }

  it.each(['disable', 'remove'] as const)('%s → 상자에 포커스, Esc로 닫힘', async (mode) => {
    render(<Harness mode={mode} />);
    const dialog = screen.getByRole('dialog');
    await pressConfirm(dialog, '확인');
    expect(document.activeElement).toBe(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('사용자가 밖으로 옮긴 포커스는 되돌리지 않는다', async () => {
    render(<Harness mode="disable" />);
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '확인' });
    fireEvent.click(confirm);
    const outside = screen.getByRole('button', { name: '밖', hidden: true });
    outside.focus();
    await settle();
    expect(document.activeElement).toBe(outside);
  });
});

describe('채널 나가기 — 요청 중·실패 뒤 포커스', () => {
  function world(leave: Promise<{ status: number; body?: unknown }>) {
    window.history.replaceState(null, '', '/');
    const server = new FakeServer();
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary()], next_cursor: null } }));
    server.on(`GET /api/conversations/${CONV}/members`, () => ({
      status: 200,
      body: { members: [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }] },
    }));
    const fetch = (input: string, init?: RequestInit): Promise<Response> =>
      init?.method === 'DELETE' && input.endsWith(`/api/conversations/${CONV}/membership`)
        ? leave.then((r) => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }))
        : server.fetch(input, init);
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    render(
      <LiveApp
        fetch={fetch}
        createSource={(deps) =>
          createHttpDataSource({
            ...deps,
            wsUrl: 'wss://oms.test/api/ws',
            createSocket: server.createSocket,
            storage: new MemoryStorage(),
            isOnline: () => true,
            setTimer: () => undefined,
            clearTimer: () => undefined,
            lifecycle: { doc, win: new EventTarget() },
          })
        }
      />,
    );
  }

  async function open(leave: Promise<{ status: number; body?: unknown }>) {
    installViewport(1280);
    setCoarsePointer(false);
    world(leave);
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    const more = screen.getByRole('button', { name: '대화 더보기' });
    more.focus();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '채널 나가기…' }));
    return { dialog: screen.getByRole('dialog'), more };
  }

  it('요청 중 Dialog 안 → Esc로 닫힘·「대화 더보기」 복귀', async () => {
    const pending = deferred<{ status: number }>();
    const { dialog, more } = await open(pending.promise);
    await pressConfirm(dialog, LEAVE_CHANNEL_COPY.confirm);
    expectFocusInside(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
    // 닫은 뒤 늦게 온 결과는 버린다(attempt 무효화 — 기존 규칙).
    pending.resolve({ status: 500 });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('실패 뒤에도 Dialog 안 → Esc로 닫힘', async () => {
    const pending = deferred<{ status: number; body?: unknown }>();
    const { dialog, more } = await open(pending.promise);
    await pressConfirm(dialog, LEAVE_CHANNEL_COPY.confirm);
    pending.resolve({ status: 500, body: { error: 'internal' } });
    await settle();
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expectFocusInside(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

describe('봇 제거 — 요청 중·실패 뒤 포커스', () => {
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
    return { dialog: screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) }), pending };
  }

  it('요청 중 Dialog 안 → Esc로 닫힘', async () => {
    const { dialog } = await open();
    await pressConfirm(dialog, BOT_CHANNEL_COPY.confirm);
    expectFocusInside(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('실패 뒤에도 Dialog 안 → Esc로 닫힘', async () => {
    const { dialog, pending } = await open();
    await pressConfirm(dialog, BOT_CHANNEL_COPY.confirm);
    pending.resolve({ ok: false, status: 'network' });
    await settle();
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expectFocusInside(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('메시지 삭제 — 요청 중·실패 뒤 포커스', () => {
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
    return { dialog: screen.getByRole('dialog', { name: DELETE_MESSAGE_COPY.title }), pending, trigger };
  }

  it('요청 중 Dialog 안 → Esc로 닫힘·트리거 복귀', async () => {
    const { dialog, trigger } = await open();
    await pressConfirm(dialog, DELETE_MESSAGE_COPY.confirm);
    expectFocusInside(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([
    ['다시 시도 가능(버튼 유지)', 'network' as const],
    ['다시 시도 불가(버튼 제거)', 403],
  ])('실패 뒤에도 Dialog 안 — %s', async (_label, status) => {
    const { dialog, pending, trigger } = await open();
    await pressConfirm(dialog, DELETE_MESSAGE_COPY.confirm);
    pending.resolve({ ok: false, status });
    await settle();
    expectFocusInside(dialog);
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
