/** QA §4-2: 주소의 대화가 확정된 목록에 없으면(나간 채널 새로고침·삭제·권한 없음·오타) 빈 화면 대신 안내 + 「채널 찾기」. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { createMemoryDataSource, type DataSource, type Snapshot } from '../../src/data';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { LiveApp } from '../../src/LiveApp.js';
import { AppShell } from '../../src/features/layout';
import { CHANNEL_BROWSER_COPY, DIALOG_TITLES, ERROR_COPY } from '../../src/ui/copy.js';
import { installViewport } from '../helpers/viewport.js';
import { CONV, FakeServer, MemoryStorage, U, flush, summary } from '../sync/fake-server.js';

const C1 = '11111111-1111-4111-8111-111111111111';
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

afterEach(cleanup);

function seed(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    spaces: [{ id: C1, kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 }],
    messages: [],
    connection: 'connected',
    ...extra,
  };
}

function withBrowse(snapshot: Snapshot): DataSource {
  return {
    ...createMemoryDataSource(snapshot),
    discoverChannels: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    joinChannel: vi.fn(() => Promise.resolve({ ok: true as const, value: C1 })),
  };
}

function open(width: number, path: string, dataSource: DataSource) {
  installViewport(width);
  return render(<AppShell dataSource={dataSource} history={createMemoryHistory(path)} />);
}

describe('주소의 대화가 목록에 없음', () => {
  it('wide: 목록 확정 후 없으면 안내와 「채널 찾기」, 누르면 채널 찾기 Dialog', async () => {
    const user = userEvent.setup();
    open(1280, `/c/${MISSING}`, withBrowse(seed()));
    const main = screen.getByRole('main');
    expect(within(main).getByText(ERROR_COPY.notFound)).toBeTruthy();
    await user.click(within(main).getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    expect(screen.getByRole('dialog', { name: DIALOG_TITLES.browseChannels })).toBeTruthy();
  });

  it('compact: 같은 안내 + 「채널 찾기」 화면, 「뒤로」는 공간 목록', async () => {
    const user = userEvent.setup();
    open(390, `/c/${MISSING}`, withBrowse(seed()));
    const main = screen.getByRole('main');
    expect(within(main).getByText(ERROR_COPY.notFound)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '공간' })).toBeNull();
    await user.click(within(main).getByRole('button', { name: '뒤로' }));
    expect(screen.queryByRole('main')).toBeNull();
    expect(screen.getByRole('navigation', { name: '공간' })).toBeTruthy();

    cleanup();
    open(390, `/c/${MISSING}`, withBrowse(seed()));
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    expect(screen.getByRole('region', { name: DIALOG_TITLES.browseChannels })).toBeTruthy();
  });

  it('목록 로딩 중·catch-up 중에는 안내를 내지 않는다(깜빡임 방지)', () => {
    open(1280, `/c/${MISSING}`, withBrowse(seed({ spaces: [], listState: 'loading' })));
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
    cleanup();
    open(1280, `/c/${MISSING}`, withBrowse(seed({ connection: 'catching-up' })));
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
  });

  it('목록에 있으면 기존 대화 화면(안내 없음)', () => {
    open(1280, `/c/${C1}`, withBrowse(seed()));
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
    expect(within(screen.getByRole('main')).getByText('general')).toBeTruthy();
  });

  it('채널 찾기 API가 없으면 안내만(버튼 없음)', () => {
    open(1280, `/c/${MISSING}`, createMemoryDataSource(seed()));
    const main = screen.getByRole('main');
    expect(within(main).getByText(ERROR_COPY.notFound)).toBeTruthy();
    expect(within(main).queryByRole('button')).toBeNull();
  });
});

describe('주소의 대화가 목록에 없음 — Codex r1 P2×2·QA D1', () => {
  const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /** 스냅샷을 바꿀 수 있는 소스 — 참여 성공·목록 재조회 결과·`open` 이력 로딩을 흉내 낸다. */
  function controllable(initial: Snapshot, extra: (set: (next: Snapshot) => void) => Partial<DataSource> = () => ({})) {
    let snap = initial;
    const listeners = new Set<() => void>();
    const set = (next: Snapshot) => {
      snap = next;
      act(() => listeners.forEach((l) => l()));
    };
    const ds: DataSource = {
      getSnapshot: () => snap,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      send: () => undefined,
      discoverChannels: vi.fn(() => Promise.resolve({ ok: true as const, value: [{ id: MISSING, name: 'left-one' }] })),
      ...extra(set),
    };
    return { ds, set };
  }

  async function joinFromNotice(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    const dialog = screen.getByRole('dialog', { name: DIALOG_TITLES.browseChannels });
    await user.click(await within(dialog).findByRole('button', { name: CHANNEL_BROWSER_COPY.join }));
  }

  it('(a) 참여는 성공했지만 목록 재조회가 실패해 목록에 없으면 안내를 내지 않는다', async () => {
    const user = userEvent.setup();
    // 재조회 실패: joinChannel은 성공 id를 돌려주지만 목록(spaces)은 그대로, listState는 기존 'ready'.
    // 데이터 계층이 「목록 미반영」을 `pendingIds`로 알린다(arrivedId 제거, Codex r3 P2).
    const { ds } = controllable(seed(), (set) => ({
      joinChannel: vi.fn(() => {
        set(seed({ pendingIds: [MISSING] }));
        return Promise.resolve({ ok: true as const, value: MISSING });
      }),
    }));
    open(1280, `/c/${MISSING}`, ds);
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
    await joinFromNotice(user);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
  });

  it('(a) 참여한 대화가 목록에 들어온 뒤 다시 사라지면 안내를 낸다(억제는 목록 반영 전까지만)', async () => {
    const user = userEvent.setup();
    const joined: Snapshot = seed({ spaces: [...seed().spaces, { id: MISSING, kind: 'channel', name: 'left-one', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 }] });
    const { ds, set } = controllable(seed(), () => ({ joinChannel: vi.fn(() => Promise.resolve({ ok: true as const, value: MISSING })) }));
    open(1280, `/c/${MISSING}`, ds);
    await joinFromNotice(user);
    set(joined);
    expect(within(screen.getByRole('main')).getByText('left-one')).toBeTruthy();
    set(seed());
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
  });

  it('(a) 다른 대화를 보는 동안 목록에 들어왔다 사라진 참여 대화로 돌아오면 안내를 낸다(Codex r2 P2)', async () => {
    const user = userEvent.setup();
    const joined: Snapshot = seed({ spaces: [...seed().spaces, { id: MISSING, kind: 'channel', name: 'left-one', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 }] });
    const { ds, set } = controllable(seed(), () => ({ joinChannel: vi.fn(() => Promise.resolve({ ok: true as const, value: MISSING })) }));
    installViewport(1280);
    const history = createMemoryHistory(`/c/${MISSING}`);
    render(<AppShell dataSource={ds} history={history} />);
    await joinFromNotice(user);
    await user.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: /general/ }));
    expect(history.pathname()).toBe(`/c/${C1}`);
    set(joined);
    set(seed());
    act(() => history.back());
    expect(history.pathname()).toBe(`/c/${MISSING}`);
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
  });

  it('(b) compact: `?thread=`가 붙은 없는 대화도 「뒤로」 1회로 공간 목록', async () => {
    const user = userEvent.setup();
    open(390, `/c/${MISSING}?thread=${ROOT}`, withBrowse(seed()));
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: '뒤로' }));
    expect(screen.queryByRole('main')).toBeNull();
    expect(screen.getByRole('navigation', { name: '공간' })).toBeTruthy();
  });

  it('(c) 안내의 「채널 찾기」로 같은 주소의 채널에 참여하면 이력을 다시 연다(open) → 메시지 표시', async () => {
    const user = userEvent.setup();
    const joined: Snapshot = seed({ spaces: [...seed().spaces, { id: MISSING, kind: 'channel', name: 'left-one', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 }] });
    const opened = vi.fn();
    const { ds } = controllable(seed(), (set) => ({
      joinChannel: vi.fn(() => {
        set(joined);
        return Promise.resolve({ ok: true as const, value: MISSING });
      }),
      open: (id: string | null) => {
        opened(id);
        // 참여 뒤 다시 연 경우에만 이력이 온다(새로고침 직후 open은 나간 채널이라 빈 이력).
        if (id === MISSING && opened.mock.calls.length > 1) {
          set({ ...joined, messages: [{ id: 'm1', conversationId: MISSING, author: '홍길동', createdAt: '2026-11-06T03:00:00.000Z', body: '이력 본문', replyCount: 0, seq: 1 }] });
        }
      },
    }));
    open(1280, `/c/${MISSING}`, ds);
    expect(opened).toHaveBeenCalledTimes(1);
    await joinFromNotice(user);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenLastCalledWith(MISSING);
    expect(screen.getByText('이력 본문')).toBeTruthy();
  });

  it('(c) 다른 대화를 보다가 참여하면 open은 선택 effect가 한 번만 부른다(중복 없음)', async () => {
    const user = userEvent.setup();
    const joined: Snapshot = seed({ spaces: [...seed().spaces, { id: MISSING, kind: 'channel', name: 'left-one', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 }] });
    const opened = vi.fn();
    const { ds } = controllable(seed(), (set) => ({
      joinChannel: vi.fn(() => {
        set(joined);
        return Promise.resolve({ ok: true as const, value: MISSING });
      }),
      open: opened,
    }));
    open(1280, `/c/${C1}`, ds);
    await user.click(screen.getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    const dialog = screen.getByRole('dialog', { name: DIALOG_TITLES.browseChannels });
    await user.click(await within(dialog).findByRole('button', { name: CHANNEL_BROWSER_COPY.join }));
    expect(opened.mock.calls.filter(([id]) => id === MISSING)).toHaveLength(1);
  });
});

/**
 * Codex r3 P2 근본 수정: 「목록 미반영」은 데이터 계층(`pendingIds`)이 알린다 — 실제 `createHttpDataSource`로 검증한다
 * (셸이 선택 경로로 추측하지 않는다 — 전환기·사이드바·뒤로가기 무관).
 */
describe('주소의 대화가 목록에 없음 — 데이터 계층 pendingIds(Codex r1·r2·r3 P2)', () => {
  const A = U(77);
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await act(flush);
  };

  /** 목록 응답을 바꿀 수 있는 서버: 'ok'=C(+A), 'fail'=503. A 참여는 성공한다. */
  function liveServer() {
    const server = new FakeServer();
    let list: 'ok' | 'fail' = 'ok';
    let withA = false;
    server.on('GET /api/conversations', () =>
      list === 'fail' ? { status: 503 } : { status: 200, body: { conversations: withA ? [summary(), summary({ id: A, name: 'left-one' })] : [summary()], next_cursor: null } },
    );
    server.on('GET /api/conversations/discover', () => ({ status: 200, body: { channels: [{ id: A, name: 'left-one' }], next_cursor: null } }));
    server.on(`POST /api/conversations/${A}/join`, () => {
      list = 'fail';
      return { status: 200, body: { id: A } };
    });
    server.on(`GET /api/conversations/${A}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    return {
      server,
      setList: (next: 'ok' | 'fail', includeA = false) => {
        list = next;
        withA = includeA;
      },
    };
  }

  function mountLive(server: FakeServer, path: string) {
    installViewport(1280);
    const sources: HttpDataSource[] = [];
    const history = createMemoryHistory(path);
    render(
      <LiveApp
        fetch={server.fetch}
        history={history}
        replacePath={() => undefined}
        readHash={() => ''}
        createSource={(deps) => {
          const ds = createHttpDataSource({
            ...deps,
            wsUrl: 'wss://oms.test/api/ws',
            createSocket: server.createSocket,
            storage: new MemoryStorage(),
            isOnline: () => true,
            setTimer: () => 0,
            clearTimer: () => undefined,
          });
          sources.push(ds);
          return ds;
        }}
      />,
    );
    return { history, source: () => sources.at(-1)! };
  }

  async function joinA() {
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: DIALOG_TITLES.browseChannels });
    fireEvent.click(within(dialog).getByRole('button', { name: CHANNEL_BROWSER_COPY.join }));
    await settle();
  }

  /** 목록 조회 성공(복귀 절차) — 성공한 목록이 진실이다. */
  async function reloadList(source: () => HttpDataSource) {
    act(() => source().reload?.());
    await settle();
  }

  const sidebarGeneral = () => within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: /general/ });

  it('r1: 참여 성공 + 목록 재조회 실패 → 안내 없음, 이후 목록 조회 성공인데 없으면 안내', async () => {
    const { server, setList } = liveServer();
    const { history, source } = mountLive(server, `/c/${A}`);
    await settle();
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
    await joinA();
    expect(history.pathname()).toBe(`/c/${A}`);
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
    setList('ok');
    await reloadList(source);
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
  });

  it('r2: 다른 대화를 보는 동안 목록에 들어왔다 사라진 참여 대화로 돌아오면 안내', async () => {
    const { server, setList } = liveServer();
    const { history, source } = mountLive(server, `/c/${A}`);
    await settle();
    await joinA();
    fireEvent.click(sidebarGeneral());
    await settle();
    expect(history.pathname()).toBe(`/c/${CONV}`);
    setList('ok', true);
    await reloadList(source);
    setList('ok', false);
    await reloadList(source);
    act(() => history.back());
    await settle();
    expect(history.pathname()).toBe(`/c/${A}`);
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
  });

  it('r3: 재조회 실패 중 사이드바 B → 전환기 B 재선택 → 뒤로 A여도 안내 없음, 목록 조회 성공 뒤 없으면 안내', async () => {
    const { server, setList } = liveServer();
    const { history, source } = mountLive(server, `/c/${A}`);
    await settle();
    await joinA();
    fireEvent.click(sidebarGeneral());
    await settle();
    expect(history.pathname()).toBe(`/c/${CONV}`);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await settle();
    fireEvent.click(screen.getByRole('option', { name: /general/ }));
    await settle();
    act(() => history.back());
    await settle();
    expect(history.pathname()).toBe(`/c/${A}`);
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
    setList('ok');
    await reloadList(source);
    expect(screen.getByText(ERROR_COPY.notFound)).toBeTruthy();
  });
});
