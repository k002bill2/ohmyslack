/**
 * W-10g 공간 진입점: Sidebar 상단·하단·빈 2종·오류, 채널 만들기(409·403), ChannelBrowser, DmStarter, 로그아웃,
 * 그리고 **빈 DB 시나리오**(대화 0개 owner → 채널 만들기 → 메시지 전송) — 운영 결함의 회귀 방지.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { ChannelBrowser, DmStarter } from '../../src/features/spaces';
import { Sidebar } from '../../src/features/sidebar';
import { readCheckpoint } from '../../src/features/sync';
import { installViewport } from '../helpers/viewport.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, message, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

const NEW_CH = U(20);
const DM = U(30);
const OWNER = { status: 200, body: { user: { id: ME, email: 'a@x', display_name: 'A', role: 'owner' }, csrf_token: 'csrf-1' } };

function mount(server: FakeServer, path = '/') {
  const storage = new MemoryStorage();
  const sources: HttpDataSource[] = [];
  const history = createMemoryHistory(path);
  const paths: string[] = [];
  render(
    <LiveApp
      fetch={server.fetch}
      history={history}
      replacePath={(p) => paths.push(p)}
      readHash={() => ''}
      createSource={(deps) => {
        const ds = createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage,
          isOnline: () => true,
          setTimer: () => 0,
          clearTimer: () => undefined,
        });
        sources.push(ds);
        return ds;
      }}
    />,
  );
  return { storage, sources, history, paths };
}

/** 대화 0개 서버. */
function emptyServer(role: 'owner' | 'member' = 'owner') {
  const server = new FakeServer();
  let conversations: unknown[] = [];
  server.on('GET /api/me', () => (role === 'owner' ? OWNER : { ...OWNER, body: { ...OWNER.body, user: { ...OWNER.body.user, role } } }));
  server.on('GET /api/conversations', () => ({ status: 200, body: { conversations, next_cursor: null } }));
  return { server, setConversations: (c: unknown[]) => (conversations = c) };
}

describe('Sidebar 진입점·빈 상태', () => {
  it('빈(관리자): 「첫 채널을 만들어 보세요」 + 「채널 만들기」, 상단 「채널 찾기」·「DM 시작」, 하단 표시 이름 + 「로그아웃」', async () => {
    installViewport(1280);
    const { server } = emptyServer('owner');
    mount(server);
    await settle();
    const nav = screen.getByRole('navigation', { name: '공간' });
    expect(within(nav).getByText('첫 채널을 만들어 보세요')).toBeTruthy();
    expect(within(nav).getByRole('button', { name: '채널 만들기' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: '채널 찾기' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'DM 시작' })).toBeTruthy();
    expect(within(nav).getByText('A')).toBeTruthy();
    expect(within(nav).getByRole('button', { name: '로그아웃' })).toBeTruthy();
  });

  it('빈(비관리자): 「채널이 없습니다 — 관리자만 생성」, 「채널 만들기」 없음, 「채널 찾기」 있음', async () => {
    installViewport(1280);
    const { server } = emptyServer('member');
    mount(server);
    await settle();
    expect(screen.getByText('채널이 없습니다 — 관리자만 생성')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '채널 만들기' })).toBeNull();
    expect(screen.getByRole('button', { name: '채널 찾기' })).toBeTruthy();
  });

  it('목록 오류(5xx): ErrorState + 「다시 시도」 → 2xx면 목록', async () => {
    installViewport(1280);
    const server = new FakeServer();
    let fail = true;
    server.on('GET /api/conversations', () => (fail ? { status: 503 } : { status: 200, body: { conversations: [summary()], next_cursor: null } }));
    mount(server);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('서버에 연결하지 못했습니다.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await settle();
    expect(screen.getByRole('button', { name: 'general' })).toBeTruthy();
  });

  it('로딩: 목록 응답 전 aria-busy Skeleton', () => {
    render(<Sidebar spaces={[]} selectedId={null} collapsed={false} onSelect={vi.fn()} listState="loading" />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('채널이 없습니다 — 관리자만 생성')).toBeNull();
  });
});

describe('빈 DB 시나리오(회귀): owner, 대화 0개 → 채널 만들기 → 그 채널에서 메시지 전송', () => {
  it('POST /api/conversations → 목록 갱신 → /c/:id 이동·구독 → 전송', async () => {
    installViewport(1280);
    const { server, setConversations } = emptyServer('owner');
    server.on('POST /api/conversations', (_u, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ kind: 'channel', name: '공지' });
      expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-1');
      setConversations([summary({ id: NEW_CH, name: '공지' })]);
      return { status: 201, body: { id: NEW_CH } };
    });
    server.on(`GET /api/conversations/${NEW_CH}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    server.on(`POST /api/conversations/${NEW_CH}/messages`, (_u, init) => {
      const b = JSON.parse(String(init?.body)) as { client_message_id: string; body: string };
      return { status: 201, body: { seq: 1, change_id: 1, mention_user_ids: [], message: message(1, { conversation_id: NEW_CH, author_id: ME, client_message_id: b.client_message_id, body: b.body }) } };
    });
    const { history } = mount(server);
    await settle();

    const trigger = screen.getByRole('button', { name: '채널 만들기' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '채널 만들기' });
    const input = within(dialog).getByRole('textbox', { name: '채널 만들기' });
    fireEvent.change(input, { target: { value: ' 공지 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '채널 만들기' }));
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(history.pathname()).toBe(`/c/${NEW_CH}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('공지');
    expect(server.log).toContain('ws conversation.subscribe');
    const listCalls = server.log.filter((l) => l === 'GET /api/conversations');
    expect(listCalls.length).toBeGreaterThanOrEqual(2);

    const composer = screen.getByRole('textbox', { name: '#공지에 메시지 작성' });
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: '첫 메시지' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
    expect(server.log).toContain(`POST /api/conversations/${NEW_CH}/messages`);
    expect(screen.getByText('첫 메시지')).toBeTruthy();
  });
});

describe('채널 만들기 오류', () => {
  it.each([
    [409, { error: { code: 'name_taken' } }, '같은 이름의 채널이 이미 있습니다. 다른 이름을 입력해 주세요.', true],
    [403, { error: { code: 'forbidden' } }, '권한이 없습니다', false],
  ])('%i → 문구, 입력란 aria-invalid=%s, Dialog 유지', async (status, body, text, invalid) => {
    installViewport(1280);
    const { server } = emptyServer('owner');
    server.on('POST /api/conversations', () => ({ status, body }));
    mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '채널 만들기' }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'general' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '채널 만들기' }));
    await settle();
    expect(within(dialog).getByText(text)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe(invalid ? 'true' : null);
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
});

describe('CMP-23 ChannelBrowser', () => {
  it('로딩 → 빈 「참여할 수 있는 채널이 없습니다」', async () => {
    let resolve: (v: { ok: true; value: [] }) => void = () => undefined;
    render(<ChannelBrowser load={() => new Promise((r) => (resolve = r))} join={vi.fn()} onJoined={vi.fn()} />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => resolve({ ok: true, value: [] }));
    expect(screen.getByText('참여할 수 있는 채널이 없습니다')).toBeTruthy();
  });

  it('오류(네트워크) → ErrorState + 다시 시도 → 기본 목록', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 'network' })
      .mockResolvedValueOnce({ ok: true, value: [{ id: 'x', name: 'random' }] });
    render(<ChannelBrowser load={load} join={vi.fn()} onJoined={vi.fn()} />);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('서버에 연결하지 못했습니다.');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await settle();
    expect(screen.getByText('random')).toBeTruthy();
  });

  it('참여 중: 해당 버튼 비활성 → 성공 시 onJoined(id) / 실패 시 ErrorState·버튼 복구', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const join = vi.fn(() => new Promise((r) => (finish = r)));
    const onJoined = vi.fn();
    render(
      <ChannelBrowser
        load={async () => ({ ok: true, value: [{ id: 'x', name: 'random' }, { id: 'y', name: 'qa' }] })}
        join={join as never}
        onJoined={onJoined}
      />,
    );
    await settle();
    const [first, second] = screen.getAllByRole('button', { name: '참여' });
    fireEvent.click(first!);
    expect((first as HTMLButtonElement).disabled).toBe(true);
    expect((second as HTMLButtonElement).disabled).toBe(false);
    await act(async () => finish({ ok: false, status: 503 }));
    expect(screen.getByRole('alert').textContent).toContain('서버에 문제가 생겨 처리하지 못했습니다.');
    expect((first as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(first!);
    await act(async () => finish({ ok: true, value: 'x' }));
    expect(onJoined).toHaveBeenCalledWith('x');
  });

  it('통합: 「채널 찾기」 → 참여 → 목록 갱신 → /c/:id 이동', async () => {
    installViewport(1280);
    const { server, setConversations } = emptyServer('member');
    server.on('GET /api/conversations/discover', () => ({ status: 200, body: { channels: [{ id: CONV, name: 'general' }], next_cursor: null } }));
    server.on(`POST /api/conversations/${CONV}/join`, () => {
      setConversations([summary()]);
      return { status: 200, body: { id: CONV } };
    });
    const { history } = mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '채널 찾기' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: '채널 찾기' });
    fireEvent.click(within(dialog).getByRole('button', { name: '참여' }));
    await settle();
    expect(history.pathname()).toBe(`/c/${CONV}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('general');
  });
});

describe('CMP-24 DmStarter', () => {
  const members = [
    { id: ME, displayName: 'A', role: 'owner' as const },
    { id: PEER, displayName: 'B', role: 'member' as const },
  ];

  it('콤보박스(접근 이름 = 제목), 본인 제외, 「DM 시작」 → onStarted(기존 DM ID 포함)', async () => {
    const start = vi.fn(async () => ({ ok: true as const, value: DM }));
    const onStarted = vi.fn();
    render(
      <>
        <h2 id="t">DM 시작</h2>
        <DmStarter labelledBy="t" selfId={ME} load={async () => ({ ok: true, value: members })} start={start} onStarted={onStarted} />
      </>,
    );
    await settle();
    const combo = screen.getByRole('combobox', { name: 'DM 시작' });
    expect(within(combo).getAllByRole('option').map((o) => o.textContent)).toEqual(['B']);
    fireEvent.click(screen.getByRole('button', { name: 'DM 시작' }));
    await settle();
    expect(start).toHaveBeenCalledWith(PEER);
    expect(onStarted).toHaveBeenCalledWith(DM);
  });

  it('빈: 본인 외 0 → 「다른 멤버가 없습니다」', async () => {
    render(<DmStarter labelledBy="t" selfId={ME} load={async () => ({ ok: true, value: [members[0]!] })} start={vi.fn()} onStarted={vi.fn()} />);
    await settle();
    expect(screen.getByText('다른 멤버가 없습니다')).toBeTruthy();
  });

  it('오류(5xx) → ErrorState + 다시 시도', async () => {
    const load = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({ ok: true, value: members });
    render(<DmStarter labelledBy="t" selfId={ME} load={load} start={vi.fn()} onStarted={vi.fn()} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await settle();
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('통합: 기존 DM이면 그 DM으로 이동(POST /api/dms가 기존 ID 반환)', async () => {
    installViewport(1280);
    const server = new FakeServer();
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: { conversations: [summary(), summary({ id: DM, kind: 'dm', name: null, peer_user_id: PEER })], next_cursor: null },
    }));
    server.on(`GET /api/conversations/${DM}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    server.on('POST /api/dms', (_u, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ user_id: PEER });
      return { status: 200, body: { id: DM } };
    });
    const { history } = mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'DM 시작' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'DM 시작' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'DM 시작' }));
    await settle();
    expect(history.pathname()).toBe(`/c/${DM}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('B');
  });
});

describe('로그아웃', () => {
  it('「로그아웃」 → POST /api/auth/logout → 본문·checkpoint 정리 → 로그인 화면(/login), 세션 종료 문구 없음', async () => {
    installViewport(1280);
    const server = new FakeServer();
    server.on('POST /api/auth/logout', () => ({ status: 204 }));
    const { sources, storage, paths } = mount(server);
    await settle();
    expect(readCheckpoint(ME, storage)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await settle();
    expect(server.log).toContain('POST /api/auth/logout');
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    expect(screen.queryByText('세션이 종료되었습니다')).toBeNull();
    expect(readCheckpoint(ME, storage)).toBeNull();
    expect(sources.at(-1)?.getSnapshot().spaces).toEqual([]);
    expect(paths.at(-1)).toBe('/login');
  });
});

describe('compact: 채널 찾기는 Dialog가 아닌 화면', () => {
  it('compact에서 「채널 찾기」 → 화면(heading) + 「닫기」로 목록 복귀', async () => {
    installViewport(400);
    const { server } = emptyServer('member');
    server.on('GET /api/conversations/discover', () => ({ status: 200, body: { channels: [], next_cursor: null } }));
    mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '채널 찾기' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: '채널 찾기' })).toBeTruthy();
    expect(screen.getByText('참여할 수 있는 채널이 없습니다')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.getByRole('navigation', { name: '공간' })).toBeTruthy();
  });
});

describe('Codex r1 반영', () => {
  it('compact: 「채널 찾기」 → /discover push, 뒤로가기 → 화면 닫힘 / `/dm/new` 직접 진입 → DM 시작 화면', async () => {
    installViewport(400);
    const { server } = emptyServer('member');
    server.on('GET /api/conversations/discover', () => ({ status: 200, body: { channels: [], next_cursor: null } }));
    const { history } = mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '채널 찾기' }));
    expect(history.pathname()).toBe('/discover');
    act(() => history.back());
    expect(screen.queryByRole('heading', { name: '채널 찾기' })).toBeNull();
    cleanup();
    const second = mount(server, '/dm/new');
    await settle();
    expect(screen.getByRole('heading', { name: 'DM 시작' })).toBeTruthy();
    expect(second.history.pathname()).toBe('/dm/new');
  });

  it('생성 POST 성공 뒤 목록 조회 실패여도 생성 성공으로 이동(재제출 409 방지)', async () => {
    installViewport(1280);
    const { server } = emptyServer('owner');
    let posted = false;
    server.on('POST /api/conversations', () => {
      posted = true;
      return { status: 201, body: { id: NEW_CH } };
    });
    server.on('GET /api/conversations', () => (posted ? { status: 503 } : { status: 200, body: { conversations: [], next_cursor: null } }));
    server.on(`GET /api/conversations/${NEW_CH}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
    const { history } = mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '채널 만들기' }));
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '채널 만들기' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(history.pathname()).toBe(`/c/${NEW_CH}`);
  });

  it('Dialog 열림 동안 배경(사이드바)은 inert, 닫히면 해제', async () => {
    installViewport(1280);
    const { server } = emptyServer('owner');
    mount(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '채널 만들기' }));
    const nav = document.querySelector('nav.sidebar') as HTMLElement;
    expect(nav.inert).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(nav.inert).toBe(false);
  });
});
