/**
 * W-10h CMP-25 MemberAdmin(`/settings/members`, UI_STATES §2-12) — 가짜 fetch(FakeServer) + LiveApp 통합.
 * 로딩·기본·권한 없음(member·403)·오류→다시 시도, 초대 발급 Dialog(링크·만료·복사·경고·닫으면 폐기),
 * 비활성화 확인 Dialog(정본 문구·확인·취소·오류·본인 행 버튼 없음), 사이드바 진입점(owner만)·경로·새로고침·뒤로가기.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { formatExpiry, inviteLink, MemberAdmin } from '../../src/features/members';
import { installViewport } from '../helpers/viewport.js';
import { FakeServer, ME, MemoryStorage, PEER, U, flush } from '../sync/fake-server.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

const TOKEN = 'tok_SECRET_abc123';
const TOKEN2 = 'tok_SECRET_second';
const EXPIRES = '2026-11-10T06:12:00.000Z';
const C = U(3);
const ME_BODY = (role: 'owner' | 'member') => ({
  status: 200,
  body: { user: { id: ME, email: 'a@x', display_name: 'A', role }, csrf_token: 'csrf-1' },
});

function adminServer(role: 'owner' | 'member' = 'owner') {
  const server = new FakeServer();
  server.on('GET /api/me', () => ME_BODY(role));
  server.on('GET /api/members', () => ({
    status: 200,
    body: {
      members: [
        { id: ME, display_name: 'A', role: 'owner' },
        { id: PEER, display_name: 'B', role: 'member' },
        { id: C, display_name: 'C', role: 'member' },
      ],
    },
  }));
  let n = 0;
  server.on('POST /api/invites', () => {
    n += 1;
    return { status: 201, body: { id: U(40 + n), token: n === 1 ? TOKEN : TOKEN2, expires_at: EXPIRES } };
  });
  server.on(`POST /api/admin/members/${PEER}/deactivate`, () => ({ status: 204 }));
  return server;
}

function mount(server: FakeServer, path = '/settings/members') {
  const history = createMemoryHistory(path);
  render(
    <LiveApp
      fetch={server.fetch}
      history={history}
      replacePath={() => undefined}
      readHash={() => ''}
      createSource={(deps) =>
        createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => true,
          setTimer: () => 0,
          clearTimer: () => undefined,
        })
      }
    />,
  );
  return { history };
}

const page = () => screen.getByRole('main', { name: '멤버 관리' });

describe('MemberAdmin 상태(UI_STATES §2-12)', () => {
  it('기본: 새로고침 `/settings/members` 복원 → 목록·역할, 「초대 링크 만들기」, 본인 행 비활성화 버튼 없음', async () => {
    installViewport(1280);
    mount(adminServer());
    await settle();
    const main = page();
    expect(within(main).getByRole('heading', { level: 1 }).textContent).toBe('멤버 관리');
    expect(within(main).getByRole('button', { name: '초대 링크 만들기' })).toBeTruthy();
    const rows = within(main).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['A관리자', 'B멤버비활성화', 'C멤버비활성화']);
    expect(within(main).queryByRole('button', { name: 'A 비활성화' })).toBeNull();
    expect(within(main).getByRole('button', { name: 'B 비활성화' }).textContent).toBe('비활성화');
  });

  it('로딩: 목록 응답 전 Skeleton → 응답 후 목록', async () => {
    let resolve: (v: { ok: true; value: readonly { id: string; displayName: string; role: 'owner' | 'member' }[] }) => void = () => undefined;
    const load = () => new Promise<never>((r) => (resolve = r as never));
    render(<MemberAdmin account={{ id: ME, role: 'owner' }} load={load} createInvite={vi.fn()} deactivate={vi.fn()} origin="https://h.test" />);
    expect(page().querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => resolve({ ok: true, value: [{ id: ME, displayName: 'A', role: 'owner' }] }));
    expect(page().querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(page()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('권한 없음(member 직접 진입): 「권한이 없습니다」, 버튼 없음', async () => {
    installViewport(1280);
    const server = adminServer('member');
    mount(server);
    await settle();
    expect(within(page()).getByText('권한이 없습니다')).toBeTruthy();
    expect(within(page()).queryAllByRole('button')).toHaveLength(0);
    expect(server.log.some((l) => l.startsWith('POST /api/invites'))).toBe(false);
  });

  it('권한 없음(서버 403): 「권한이 없습니다」, 버튼 없음', async () => {
    installViewport(1280);
    const server = adminServer();
    server.on('GET /api/members', () => ({ status: 403, body: { error: { code: 'forbidden' } } }));
    mount(server);
    await settle();
    expect(within(page()).getByText('권한이 없습니다')).toBeTruthy();
    expect(within(page()).queryAllByRole('button')).toHaveLength(0);
  });

  it('오류(5xx·네트워크) → ErrorState + 「다시 시도」 → 2xx면 기본', async () => {
    installViewport(1280);
    const server = adminServer();
    let fail: 'network' | 503 | null = 503;
    const ok = server.routes.get('GET /api/members')!;
    server.on('GET /api/members', (u, i) => (fail === 'network' ? 'network' : fail === 503 ? { status: 503 } : ok(u, i)));
    mount(server);
    await settle();
    expect(within(page()).getByRole('alert')).toBeTruthy();
    fail = 'network';
    fireEvent.click(within(page()).getByRole('button', { name: '다시 시도' }));
    await settle();
    expect(within(page()).getByRole('alert').textContent).toContain('다시 시도');
    fail = null;
    fireEvent.click(within(page()).getByRole('button', { name: '다시 시도' }));
    await settle();
    expect(within(page()).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('초대 링크 발급 Dialog(UI_STATES §2-8·§2-12, D §10-2 S1)', () => {
  it('발급 → 링크(`origin/invite#t=`)·만료 시각(Asia/Seoul)·복사·경고, 토큰은 저장소·콘솔·주소에 없음', async () => {
    installViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const server = adminServer();
    const { history } = mount(server);
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: '초대 링크 만들기' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: '초대 링크 만들기' });
    const input = within(dialog).getByRole('textbox', { name: '초대 링크 만들기' }) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(`${location.origin}/invite#t=${TOKEN}`);
    expect(within(dialog).getByText('2026. 11. 10. 오후 3:12')).toBeTruthy();
    expect(within(dialog).getByText('이 창을 닫으면 다시 볼 수 없습니다')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '복사' }));
    await settle();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/invite#t=${TOKEN}`);
    // 메모리 밖 흔적 0: localStorage·sessionStorage·console·주소(history)
    expect(setItem.mock.calls.flat().join(' ')).not.toContain(TOKEN);
    expect(JSON.stringify([localStorage, sessionStorage])).not.toContain(TOKEN);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    expect(history.entries().join(' ')).not.toContain(TOKEN);
    expect(location.href).not.toContain(TOKEN);
  });

  it('닫으면 폐기: 다시 열면 새로 발급(이전 링크 DOM에 없음)', async () => {
    installViewport(1280);
    const server = adminServer();
    mount(server);
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: '초대 링크 만들기' }));
    await settle();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(within(page()).getByRole('button', { name: '초대 링크 만들기' }));
    await settle();
    const input = within(screen.getByRole('dialog')).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toContain(TOKEN2);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(server.log.filter((l) => l === 'POST /api/invites')).toHaveLength(2);
  });

  it('복사 실패 → 입력 전체 선택 폴백', async () => {
    installViewport(1280);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    mount(adminServer());
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: '초대 링크 만들기' }));
    await settle();
    const input = within(screen.getByRole('dialog')).getByRole('textbox') as HTMLInputElement;
    input.setSelectionRange(0, 0);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '복사' }));
    await settle();
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  });

  it('오류 → ErrorState(「다시 시도」로 재발급), 403 → 「권한이 없습니다」', async () => {
    installViewport(1280);
    const server = adminServer();
    let reply: { status: number } | null = { status: 503 };
    const ok = server.routes.get('POST /api/invites')!;
    server.on('POST /api/invites', (u, i) => reply ?? ok(u, i));
    mount(server);
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: '초대 링크 만들기' }));
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    reply = null;
    fireEvent.click(within(dialog).getByRole('button', { name: '다시 시도' }));
    await settle();
    expect((within(dialog).getByRole('textbox') as HTMLInputElement).value).toContain(TOKEN);
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    reply = { status: 403 };
    fireEvent.click(within(page()).getByRole('button', { name: '초대 링크 만들기' }));
    await settle();
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('권한이 없습니다');
  });
});

describe('멤버 비활성화 확인 Dialog(UI_STATES §2-8, §2-12 비활성화 완료)', () => {
  it('정본 문구 → 확인 → POST → 행 muted + 「비활성」, 버튼 사라짐', async () => {
    installViewport(1280);
    const server = adminServer();
    mount(server);
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: 'B 비활성화' }));
    const dialog = screen.getByRole('dialog', { name: '멤버 비활성화' });
    expect(within(dialog).getByText('이 멤버의 모든 기기가 5초 안에 로그아웃되며 다시 로그인할 수 없습니다')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '멤버 비활성화' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(server.log).toContain(`POST /api/admin/members/${PEER}/deactivate`);
    const row = within(page()).getAllByRole('listitem')[1]!;
    expect(row.className).toContain('member-inactive');
    expect(row.textContent).toBe('B멤버비활성');
    expect(within(page()).queryByRole('button', { name: 'B 비활성화' })).toBeNull();
  });

  it('취소 → 요청 없음, 행 그대로', async () => {
    installViewport(1280);
    const server = adminServer();
    mount(server);
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: 'B 비활성화' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(server.log.some((l) => l.includes('/deactivate'))).toBe(false);
    expect(within(page()).getByRole('button', { name: 'B 비활성화' })).toBeTruthy();
  });

  it('닫힌 확인창의 늦은 응답은 새 확인창을 바꾸지 않고, 성공은 행에 반영(Codex r1 P2)', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const deactivate = vi.fn((id: string) =>
      id === PEER ? new Promise<{ ok: true; value: null }>((r) => (finish = () => r({ ok: true, value: null }))) : Promise.resolve({ ok: true as const, value: null }),
    );
    const members = [
      { id: ME, displayName: 'A', role: 'owner' as const },
      { id: PEER, displayName: 'B', role: 'member' as const },
      { id: C, displayName: 'C', role: 'member' as const },
    ];
    render(<MemberAdmin account={{ id: ME, role: 'owner' }} load={async () => ({ ok: true, value: members })} createInvite={vi.fn()} deactivate={deactivate} origin="https://h.test" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'B 비활성화' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '멤버 비활성화' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: 'C 비활성화' }));
    await act(async () => finish(true));
    const dialog = screen.getByRole('dialog', { name: '멤버 비활성화' });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('listitem')[1]!.className).toContain('member-inactive');
  });

  it('오류 → Dialog 안 ErrorState, 행 그대로', async () => {
    installViewport(1280);
    const server = adminServer();
    server.on(`POST /api/admin/members/${PEER}/deactivate`, () => ({ status: 409, body: { error: { code: 'owner_protected' } } }));
    mount(server);
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: 'B 비활성화' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '멤버 비활성화' }));
    await settle();
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeTruthy();
    expect(within(page()).getAllByRole('listitem')[1]!.className).not.toContain('member-inactive');
  });
});

describe('사이드바 진입점·경로(D §4-2)', () => {
  it('owner: 하단 「멤버 관리」 → `/settings/members` push → 뒤로가기로 이전 화면', async () => {
    installViewport(1280);
    const { history } = mount(adminServer(), '/');
    await settle();
    const nav = screen.getByRole('navigation', { name: '공간' });
    fireEvent.click(within(nav).getByRole('button', { name: '멤버 관리' }));
    await settle();
    expect(history.pathname()).toBe('/settings/members');
    expect(page()).toBeTruthy();
    act(() => history.back());
    await settle();
    expect(screen.queryByRole('main', { name: '멤버 관리' })).toBeNull();
    expect(history.pathname()).not.toBe('/settings/members');
  });

  it('member: 「멤버 관리」 진입점 없음', async () => {
    installViewport(1280);
    mount(adminServer('member'), '/');
    await settle();
    expect(screen.queryByRole('button', { name: '멤버 관리' })).toBeNull();
  });

  it('공간 선택 → 멤버 관리 닫고 `/c/:id`', async () => {
    installViewport(1280);
    const { history } = mount(adminServer());
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    expect(screen.queryByRole('main', { name: '멤버 관리' })).toBeNull();
    expect(history.pathname()).toMatch(/^\/c\//);
  });

  it('Ctrl+Alt+↓ 공간 이동 → 멤버 관리 닫힘(Codex r1 P2)', async () => {
    installViewport(1280);
    const { history } = mount(adminServer());
    await settle();
    fireEvent.keyDown(page(), { key: 'ArrowDown', ctrlKey: true, altKey: true });
    await settle();
    expect(screen.queryByRole('main', { name: '멤버 관리' })).toBeNull();
    expect(history.pathname()).toMatch(/^\/c\//);
  });

  it('Dialog 열림 → 사이드바(앱 루트)가 inert(Codex r1 P2)', async () => {
    installViewport(1280);
    mount(adminServer());
    await settle();
    fireEvent.click(within(page()).getByRole('button', { name: 'B 비활성화' }));
    const nav = document.querySelector('nav.sidebar') as HTMLElement;
    const inertUp = (el: HTMLElement | null): boolean => el !== null && (el.inert || inertUp(el.parentElement));
    expect(inertUp(nav)).toBe(true);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '취소' }));
    expect(inertUp(nav)).toBe(false);
  });

  it('compact: 멤버 관리 화면 + 「닫기」', async () => {
    installViewport(390);
    mount(adminServer());
    await settle();
    expect(page()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await settle();
    expect(screen.queryByRole('main', { name: '멤버 관리' })).toBeNull();
  });
});

describe('보조 함수', () => {
  it('formatExpiry: Asia/Seoul 고정(TZ 무관), 잘못된 값은 그대로', () => {
    expect(formatExpiry(EXPIRES)).toBe('2026. 11. 10. 오후 3:12');
    expect(formatExpiry('nope')).toBe('nope');
  });
  it('inviteLink: 프래그먼트 `#t=`', () => {
    expect(inviteLink('https://h.test', 'a b')).toBe('https://h.test/invite#t=a%20b');
  });
  it('MemberAdmin 단독: account 없음 → 권한 없음', () => {
    const load = vi.fn();
    render(<MemberAdmin account={undefined} load={load} createInvite={vi.fn()} deactivate={vi.fn()} />);
    expect(screen.getByText('권한이 없습니다')).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });
});
