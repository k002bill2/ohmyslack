/**
 * FR-CONV-06 채널 삭제(웹): 헤더 더보기 「채널 삭제…」(owner·채널만) → CMP-18 확인 Dialog → DELETE /api/conversations/{id}.
 * 성공: 목록에서 제거·다음 채널로 이동·포커스는 비텍스트(제목). 실패: Dialog 유지·오류 표시·목록 불변.
 * 다른 기기: WS `conversation.deleted` → 목록 제거, 보던 대화면 MissingConversation, 오류 배너 없음.
 * 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { CANCEL_LABEL, DELETE_CHANNEL_COPY, ERROR_COPY, HEADER_MENU_COPY } from '../../src/ui/copy.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const CONV2 = U(11);
const DM = U(12);
const nav = () => screen.getByRole('navigation', { name: '공간' });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world(opts: { role?: 'owner' | 'member'; deleteReply?: 204 | 403 | 'network' } = {}) {
  window.history.replaceState(null, '', '/');
  const server = new FakeServer();
  const state = { deleted: false };
  server.on('GET /api/me', () => ({
    status: 200,
    body: { user: { id: ME, email: 'a@x', display_name: 'A', role: opts.role ?? 'owner' }, csrf_token: 'csrf-1' },
  }));
  server.on('GET /api/conversations', () => ({
    status: 200,
    body: {
      conversations: [
        ...(state.deleted ? [] : [summary()]),
        summary({ id: CONV2, name: 'random' }),
        summary({ id: DM, kind: 'dm', name: null, peer_user_id: PEER }),
      ],
      next_cursor: null,
    },
  }));
  for (const id of [CONV, CONV2, DM]) {
    server.on(`GET /api/conversations/${id}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    server.on(`GET /api/conversations/${id}/members`, () => ({
      status: 200,
      body: { members: [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }] },
    }));
  }
  server.on(`DELETE /api/conversations/${CONV}`, () => {
    const reply = opts.deleteReply ?? 204;
    if (reply === 'network') return 'network';
    if (reply !== 204) return { status: reply, body: { error: { code: 'forbidden', message: 'x' } } };
    state.deleted = true;
    return { status: 204 };
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  render(
    <LiveApp
      fetch={server.fetch}
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
  return { server, state };
}

async function openSpace(name: string) {
  fireEvent.click(within(nav()).getByRole('button', { name }));
  await settle();
}

function openMenu() {
  const more = screen.getByRole('button', { name: HEADER_MENU_COPY.more });
  more.focus();
  fireEvent.click(more);
  return more;
}

const deletes = (server: FakeServer) => server.log.filter((l) => l === `DELETE /api/conversations/${CONV}`).length;

describe('FR-CONV-06 「채널 삭제…」 메뉴 표시 조건', () => {
  it('owner·채널: 맨 아래 danger 항목', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    world();
    await settle();
    await openSpace('general');
    openMenu();
    const items = screen.getAllByRole('menuitem');
    expect(items.at(-1)?.textContent).toBe(HEADER_MENU_COPY.deleteChannel);
  });

  it('member·채널: 항목 없음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    world({ role: 'member' });
    await settle();
    await openSpace('general');
    openMenu();
    expect(screen.queryByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel })).toBeNull();
  });

  it('owner·DM: 항목 없음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    world();
    await settle();
    await openSpace('B');
    openMenu();
    expect(screen.queryByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel })).toBeNull();
  });
});

describe('FR-CONV-06 확인 Dialog', () => {
  it.each([
    [1280, false],
    [390, true],
  ])('%ipx coarse=%s: 성공 → DELETE 1회·목록 제거·다음 채널·포커스 비텍스트', async (width, coarse) => {
    installViewport(width);
    setCoarsePointer(coarse);
    const { server } = world();
    await settle();
    await openSpace('general');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(DELETE_CHANNEL_COPY.body('general'));
    const confirm = within(dialog).getByRole('button', { name: DELETE_CHANNEL_COPY.confirm });
    fireEvent.click(confirm);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    await settle();
    expect(deletes(server)).toBe(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe(`/c/${CONV2}`);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'random' }));
    if (width !== 390) expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
  });

  it.each([[403 as const], ['network' as const]])('실패(%s): Dialog 유지 + 오류, 목록 불변', async (reply) => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world({ deleteReply: reply });
    await settle();
    await openSpace('general');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: DELETE_CHANNEL_COPY.confirm }));
    await settle();
    expect(deletes(server)).toBe(1);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(within(nav()).getByRole('button', { name: 'general' })).toBeTruthy();
  });

  it.each(['cancel', 'escape'])('%s: 요청 0, 포커스 트리거 복귀', async (how) => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('general');
    const more = openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel }));
    const dialog = screen.getByRole('dialog');
    if (how === 'cancel') fireEvent.click(within(dialog).getByRole('button', { name: CANCEL_LABEL }));
    else fireEvent.keyDown(dialog, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deletes(server)).toBe(0);
    expect(document.activeElement).toBe(more);
  });
});

describe('FR-CONV-06 WS conversation.deleted', () => {
  it('배경 채널: 목록에서 제거, 오류 배너 없음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('random');
    await act(async () => {
      server.socket.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'random' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('보던 채널: error not_found 다음 프레임 → MissingConversation, 오류 배너 없음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server, state } = world();
    await settle();
    await openSpace('general');
    state.deleted = true;
    await act(async () => {
      server.socket.push({ type: 'error', code: 'not_found', retryable: false, conversation_id: CONV });
      server.socket.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(screen.queryByRole('button', { name: HEADER_MENU_COPY.more })).toBeNull();
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('재연결(resume) 중 보던 채널 삭제 → 복귀 절차가 끝나 배경 구독까지 재개', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('general');
    server.autoAck = false;
    await act(async () => {
      server.socket.serverClose(1008);
    });
    await settle();
    const resumed = server.socket;
    expect(resumed.sent.some((f) => (f as { type: string; conversation_id: string }).conversation_id === CONV)).toBe(true);
    await act(async () => {
      resumed.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    const subs = resumed.sent.filter((f) => (f as { type: string }).type === 'conversation.subscribe') as { conversation_id: string }[];
    expect(subs.some((f) => f.conversation_id === CONV2)).toBe(true);
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
  });

  it('삭제 뒤 늦은 목록 응답(삭제 채널 포함)이 채널을 되살리지 않고 subscribe 재전송 0', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('random');
    const sock = server.socket;
    await act(async () => {
      sock.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    const before = sock.sent.length;
    // 서버 목록은 아직 CONV를 준다(state.deleted=false) — read.updated가 목록 재조회를 일으킨다.
    await act(async () => {
      sock.push({ type: 'read.updated', conversation_id: CONV2, root_id: null, last_read_seq: 1 });
    });
    await settle();
    expect(server.log.filter((l) => l === 'GET /api/conversations').length).toBeGreaterThan(1);
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    const resub = sock.sent.slice(before).filter((f) => (f as { type: string; conversation_id: string }).type === 'conversation.subscribe' && (f as { conversation_id: string }).conversation_id === CONV);
    expect(resub).toHaveLength(0);
  });
});
