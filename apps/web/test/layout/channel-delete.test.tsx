/**
 * FR-CONV-06 채널 삭제(웹): 헤더 더보기 「채널 삭제…」(owner·채널만) → CMP-18 확인 Dialog → DELETE /api/conversations/{id}.
 * 성공: 목록에서 제거·다음 채널로 이동·포커스는 비텍스트(제목). 실패: Dialog 유지·오류 표시·목록 불변.
 * 다른 기기: WS `conversation.deleted` → 목록 제거, 보던 대화면 MissingConversation, 오류 배너 없음.
 * 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import type { Account, ActionResult } from '../../src/data/index.js';
import { createDraftStore } from '../../src/features/conversation/index.js';
import { AppShell } from '../../src/features/layout/index.js';
import { memory } from '../helpers/fixtures.js';
import { CANCEL_LABEL, DELETE_CHANNEL_COPY, ERROR_COPY, HEADER_MENU_COPY, LEAVE_CHANNEL_COPY } from '../../src/ui/copy.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const CONV2 = U(11);
const DM = U(12);
const CONV3 = U(13);
const nav = () => screen.getByRole('navigation', { name: '공간' });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world(opts: { role?: 'owner' | 'member'; deleteReply?: 204 | 403 | 'network'; onlyGeneral?: boolean; gate?: Promise<void>; three?: boolean; wsFirst?: boolean; snapshot404?: boolean; online?: { value: boolean }; joinOk?: boolean } = {}) {
  window.history.replaceState(null, '', '/');
  const server = new FakeServer();
  const state = { deleted: false, left: false, gone: new Set<string>() };
  const timers: (() => void)[] = [];
  const ref: { source: HttpDataSource | null } = { source: null };
  server.on('GET /api/me', () => ({
    status: 200,
    body: { user: { id: ME, email: 'a@x', display_name: 'A', role: opts.role ?? 'owner' }, csrf_token: 'csrf-1' },
  }));
  server.on('GET /api/conversations', () => ({
    status: 200,
    body: {
      conversations: [
        ...(state.deleted || state.left ? [] : [summary()]),
        ...(opts.onlyGeneral === true || state.gone.has(CONV2) ? [] : [summary({ id: CONV2, name: 'random' })]),
        ...(opts.three === true && !state.gone.has(CONV3) ? [summary({ id: CONV3, name: 'zeta' })] : []),
        summary({ id: DM, kind: 'dm', name: null, peer_user_id: PEER }),
      ],
      next_cursor: null,
    },
  }));
  for (const id of [CONV, CONV2, DM, CONV3]) {
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
  server.on(`DELETE /api/conversations/${CONV}/membership`, () => {
    state.left = true;
    return { status: 204 };
  });
  for (const id of [CONV2, CONV3]) {
    server.on(`DELETE /api/conversations/${id}`, () => {
      state.gone.add(id);
      // wsFirst: 서버가 커밋 직후 WS conversation.deleted를 HTTP 204보다 먼저 보낸다.
      if (opts.wsFirst === true) server.socket.push({ type: 'conversation.deleted', conversation_id: id });
      return { status: 204 };
    });
  }
  server.on('PUT /api/read-state', () => ({ status: 204 }));
  if (opts.snapshot404 === true) {
    // 목록 직후 CONV 접근을 잃는다(삭제 또는 다른 기기에서 나감) — 이후 목록에서도 빠진다.
    server.on('GET /api/sync/snapshot', (url) => {
      if (url.searchParams.get('conversation_id') !== CONV) return { status: 200, body: { snapshot_cursor: 0, conversation_id: CONV2, messages: [], has_more: false, next_before_seq: null } };
      state.left = true;
      return { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
    });
  }
  server.on(`POST /api/conversations/${CONV}/join`, () => {
    if (opts.joinOk !== true) return { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
    state.left = false;
    return { status: 200, body: { id: CONV } };
  });
  server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 404, body: { error: { code: 'not_found', message: 'x' } } }));
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const win = new EventTarget();
  const gate = opts.gate;
  const fetch: typeof server.fetch = (input, init) =>
    gate !== undefined && init?.method === 'DELETE' && input.endsWith(`/api/conversations/${CONV}`) ? gate.then(() => server.fetch(input, init)) : server.fetch(input, init);
  render(
    <LiveApp
      fetch={fetch}
      createSource={(deps) => {
        const source = createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => opts.online?.value ?? true,
          setTimer: (fn) => {
            timers.push(fn);
            return undefined;
          },
          clearTimer: () => undefined,
          lifecycle: { doc, win },
        });
        ref.source = source;
        return source;
      }}
    />,
  );
  return { server, state, timers, ref, win };
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

const confirmDelete = () => {
  fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: DELETE_CHANNEL_COPY.confirm }));
};

describe('FR-CONV-06 삭제 후 이동·포커스·전환 (fix2)', () => {
  it('마지막 채널 삭제: 이동 대상 없음, 포커스는 BODY가 아니라 사이드바 항목', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    world({ onlyGeneral: true });
    await settle();
    await openSpace('general');
    openMenu();
    confirmDelete();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(document.activeElement).not.toBe(document.body);
    expect(nav().contains(document.activeElement)).toBe(true);
  });

  it('나간 채널(owner) 삭제: 목록·나간 채널 영역에서 제거', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('general');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.leave }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    expect(within(nav()).getByRole('button', { name: 'general' })).toBeTruthy();
    openMenu();
    confirmDelete();
    await settle();
    expect(deletes(server)).toBe(1);
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(screen.queryByText(/general/)).toBeNull();
  });

  it('실패 표시된 삭제 Dialog에서 다른 채널로 전환 → Dialog 닫힘·실패 문구 없음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    world({ deleteReply: 403 });
    await settle();
    await openSpace('general');
    openMenu();
    confirmDelete();
    await settle();
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeTruthy();
    await openSpace('random');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.deleteChannel }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  it('늦은 DELETE 응답 중 다른 대화로 이동 → 삭제 완료 후 사용자를 끌고 가지 않음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    world({ gate });
    await settle();
    await openSpace('general');
    openMenu();
    confirmDelete();
    await settle();
    await openSpace('B');
    expect(window.location.pathname).toBe(`/c/${DM}`);
    await act(async () => {
      release();
    });
    await settle();
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(window.location.pathname).toBe(`/c/${DM}`);
  });
});

describe('FR-CONV-06 삭제 후 다음 채널 (fix3)', () => {
  it.each([
    ['random', 'zeta', false],
    ['zeta', 'random', false],
    ['random', 'zeta', true],
    ['zeta', 'random', true],
  ])('3채널 [general, random, zeta]: %s 삭제 → %s (WS 먼저=%s)', async (target, expected, wsFirst) => {
    installViewport(1280);
    setCoarsePointer(false);
    world({ three: true, wsFirst });
    await settle();
    await openSpace(target);
    openMenu();
    confirmDelete();
    await settle();
    expect(within(nav()).queryByRole('button', { name: target })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: expected }));
  });
});

describe('FR-CONV-06 재연결·오프라인 정합 (fix3)', () => {
  it('snapshot 순회 중 한 채널 404 → 그 채널만 정리, connection은 connected로 복귀', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { ref } = world({ snapshot404: true });
    await settle();
    expect(ref.source?.getSnapshot().connection).toBe('connected');
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'random' })).toBeTruthy();
  });

  it('나간 채널이 나가 있는 동안 삭제됨 → 다시 참여 404 → 나간 채널 영역에서 제거', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { ref } = world({ role: 'member' });
    await settle();
    await openSpace('general');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: HEADER_MENU_COPY.leave }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    expect(within(nav()).getByRole('button', { name: 'general' })).toBeTruthy();
    let res: ActionResult<unknown> | undefined;
    await act(async () => {
      res = await ref.source?.joinChannel?.(CONV);
    });
    await settle();
    expect(res?.ok).toBe(false);
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
  });

  it('재연결 구독 not_found(오프라인 중 삭제 — 미확정) → 읽음 대기열 정리, 초안 폐기 알림 없음(fix4)', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server, state, timers, ref } = world();
    await settle();
    await openSpace('general');
    const seen: string[] = [];
    ref.source?.onConversationDeleted?.((id) => seen.push(id));
    act(() => ref.source?.markRead?.(CONV, null, 7));
    server.autoAck = false;
    state.deleted = true;
    await act(async () => {
      server.socket.serverClose(1008);
    });
    await settle();
    await act(async () => {
      server.socket.push({ type: 'error', code: 'not_found', retryable: false, conversation_id: CONV });
    });
    await settle();
    expect(seen).toEqual([]);
    const at = server.log.length;
    await act(async () => {
      timers.splice(0).forEach((fn) => fn());
    });
    await settle();
    expect(server.log.slice(at).filter((l) => l.startsWith('PUT /api/read-state'))).toHaveLength(0);
  });

  it('runResume: 소켓 대기 중 보던 채널 삭제 → 그 채널 subscribe 0', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('general');
    const old = server.socket;
    server.autoOpen = false;
    await act(async () => {
      old.serverClose(1008);
    });
    await settle();
    // 새 소켓이 열리기 전(waitOpen 대기) 삭제가 반영된다.
    const next = server.socket;
    expect(next).not.toBe(old);
    await act(async () => {
      next.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await act(async () => {
      next.open();
    });
    await settle();
    const subs = next.sent.filter((f) => (f as { type: string; conversation_id?: string }).type === 'conversation.subscribe' && (f as { conversation_id?: string }).conversation_id === CONV);
    expect(subs).toHaveLength(0);
  });
});

describe('FR-CONV-06 보류 메시지 정리 (fix3)', () => {
  it('오프라인 큐 메시지 → 삭제 → online 복귀: 그 대화 POST 0건', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const online = { value: false };
    const { server, ref, win } = world({ online });
    await settle();
    await openSpace('random');
    await act(async () => {
      ref.source?.send({ conversationId: CONV }, '오프라인 메시지');
    });
    await settle();
    const queued = () => ref.source?.getSnapshot().messages.some((m) => m.conversationId === CONV && m.pending !== undefined) ?? false;
    expect(queued()).toBe(true);
    await act(async () => {
      server.socket.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    online.value = true;
    await act(async () => {
      win.dispatchEvent(new Event('online'));
    });
    await settle();
    expect(server.log.filter((l) => l === `POST /api/conversations/${CONV}/messages`)).toHaveLength(0);
    expect(queued()).toBe(false);
  });
});

describe('FR-CONV-06 DataSource 정리 (fix2)', () => {
  it('삭제 후 그 대화의 읽음 대기열이 PUT /api/read-state로 나가지 않음', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server, timers, ref } = world();
    await settle();
    await openSpace('general');
    act(() => ref.source?.markRead?.(CONV, null, 7));
    await act(async () => {
      server.socket.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    const puts = server.log.length;
    await act(async () => {
      timers.splice(0).forEach((fn) => fn());
    });
    await settle();
    expect(server.log.slice(puts).filter((l) => l.startsWith('PUT /api/read-state'))).toHaveLength(0);
  });

  it('배경 채널 삭제 → conversation.unsubscribe 전송', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server } = world();
    await settle();
    await openSpace('random');
    const sock = server.socket;
    const subscribed = sock.sent.some((f) => (f as { type: string; conversation_id?: string }).type === 'conversation.subscribe' && (f as { conversation_id?: string }).conversation_id === CONV);
    await act(async () => {
      sock.push({ type: 'conversation.deleted', conversation_id: CONV });
    });
    await settle();
    const unsub = sock.sent.filter((f) => (f as { type: string; conversation_id?: string }).type === 'conversation.unsubscribe' && (f as { conversation_id?: string }).conversation_id === CONV);
    expect(subscribed).toBe(true);
    expect(unsub).toHaveLength(1);
  });
});

function draftWorld() {
  const listeners = new Set<(id: string) => void>();
  const base = memory({ account: { id: 'me', email: 'a@x', displayName: '나', role: 'owner' } as Account });
  const drafts = createDraftStore();
  const source = {
    ...base,
    deleteChannel: (id: string): Promise<ActionResult<null>> => {
      listeners.forEach((l) => l(id));
      return Promise.resolve({ ok: true, value: null });
    },
    onConversationDeleted: (l: (id: string) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  render(<AppShell dataSource={source} drafts={drafts} />);
  return { drafts, wsDeleted: (id: string) => listeners.forEach((l) => l(id)) };
}

describe('FR-CONV-06 초안 폐기 (fix2)', () => {
  it('본인 삭제: 메인·열린 스레드 초안 폐기, 다른 채널 초안 유지', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const user = userEvent.setup();
    const { drafts } = draftWorld();
    drafts.set('c2', 'dev 초안');
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.type(screen.getByRole('textbox', { name: '#general에 메시지 작성' }), '본문 초안');
    const reply = document.querySelector<HTMLElement>('[data-reply-for="m1"]');
    if (reply === null) throw new Error('답글 버튼 없음');
    await user.click(reply);
    await user.type(screen.getByRole('textbox', { name: '답글 작성' }), '스레드 초안');
    drafts.set('m2', '다른 스레드 초안');
    expect(drafts.get('c1')).toBe('본문 초안');
    expect(drafts.get('m1')).toBe('스레드 초안');
    openMenu();
    confirmDelete();
    await settle();
    expect(drafts.get('c1')).toBe('');
    expect(drafts.get('m1')).toBe('');
    expect(drafts.get('m2')).toBe('');
    expect(drafts.get('c2')).toBe('dev 초안');
  });

  it('WS 삭제(배경 채널): 그 대화의 메인·스레드 초안 폐기, 보는 채널 초안 유지', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const user = userEvent.setup();
    const { drafts, wsDeleted } = draftWorld();
    drafts.set('c1', '본문 초안');
    drafts.set('m1', '스레드 초안');
    drafts.set('m2', '스레드 초안2');
    await user.click(screen.getByRole('button', { name: /^dev/ }));
    await user.type(screen.getByRole('textbox', { name: '#dev에 메시지 작성' }), 'dev 초안');
    act(() => wsDeleted('c1'));
    expect(drafts.get('c1')).toBe('');
    expect(drafts.get('m1')).toBe('');
    expect(drafts.get('m2')).toBe('');
    expect(drafts.get('c2')).toBe('dev 초안');
  });
});

describe('FR-CONV-06 미확정 접근 상실은 초안·큐를 남긴다 (fix4, Aside r3)', () => {
  it('다른 기기에서 나간 현재 채널: 재연결 not_found → 초안 알림·오프라인 큐 유지, 재참여 성공 → 목록·열기 복귀', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const online = { value: false };
    const { server, state, ref } = world({ online, joinOk: true });
    await settle();
    await openSpace('general');
    const seen: string[] = [];
    ref.source?.onConversationDeleted?.((id) => seen.push(id));
    act(() => {
      ref.source?.send({ conversationId: CONV }, '오프라인 메시지');
    });
    await settle();
    const queued = () => ref.source?.getSnapshot().messages.some((m) => m.conversationId === CONV && m.pending !== undefined) ?? false;
    expect(queued()).toBe(true);
    server.autoAck = false;
    state.left = true;
    await act(async () => {
      server.socket.serverClose(1008);
    });
    await settle();
    await act(async () => {
      server.socket.push({ type: 'error', code: 'not_found', retryable: false, conversation_id: CONV });
    });
    await settle();
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    expect(seen).toEqual([]);
    expect(queued()).toBe(true);
    server.autoAck = true;
    let res: ActionResult<unknown> | undefined;
    await act(async () => {
      res = await ref.source?.joinChannel?.(CONV);
    });
    await settle();
    expect(res?.ok).toBe(true);
    expect(within(nav()).getByRole('button', { name: 'general' })).toBeTruthy();
    act(() => ref.source?.open(CONV));
    await settle();
    expect(ref.source?.getSnapshot().spaces.some((sp) => sp.id === CONV)).toBe(true);
    expect(queued()).toBe(true);
  });

  it('snapshot 404(삭제 아님) → connected 복귀, 목록 재등장 시 그 채널이 다시 보인다', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    const { server, state, ref } = world({ snapshot404: true });
    await settle();
    expect(ref.source?.getSnapshot().connection).toBe('connected');
    expect(within(nav()).queryByRole('button', { name: 'general' })).toBeNull();
    // 다른 기기에서 다시 참여해 서버 목록에 돌아온다 — read.updated가 목록 재조회를 일으킨다.
    state.left = false;
    await act(async () => {
      server.socket.push({ type: 'read.updated', conversation_id: CONV2, root_id: null, last_read_seq: 1 });
    });
    await settle();
    expect(within(nav()).getByRole('button', { name: 'general' })).toBeTruthy();
  });
});
