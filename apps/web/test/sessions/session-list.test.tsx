/**
 * W-30 CMP-22 SessionList(`/settings/sessions`, UI_STATES §2-14, COPY_GAPS G-63–G-72) — FR-AUTH-04 보조 컴포넌트 테스트.
 * UI-AC-12–18·20. UI-AC-19(두 기기 실기 원격 로그아웃 5초)는 QA 항목.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { LiveApp } from '../../src/LiveApp.js';
import type { ActionResult, DeviceSession } from '../../src/data';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { lastUsedWhen, SessionList, sortSessions } from '../../src/features/sessions';
import { ERROR_COPY, SESSION_LIST_COPY } from '../../src/ui/copy.js';
import { tokens } from '../../src/ui/tokens.js';
import { installViewport } from '../helpers/viewport.js';
import { FakeServer, MemoryStorage, U, flush } from '../sync/fake-server.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

/** 기준 시각: 2026-11-14 15:00 KST(TZ=Asia/Seoul 고정). */
const NOW = new Date('2026-11-14T06:00:00.000Z');
const S_THIS = U(101);
const S_MAC = U(102);
const S_PHONE = U(103);

const session = (id: string, label: string | null, lastSeenAt: string, current = false): DeviceSession => ({
  id,
  deviceLabel: label,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastSeenAt,
  current,
});

const THREE: readonly DeviceSession[] = [
  session(S_PHONE, 'iPhone · Safari', '2026-11-10T01:00:00.000Z'),
  session(S_THIS, 'Mac · Chrome', '2026-11-14T05:59:00.000Z', true),
  session(S_MAC, 'Mac · Firefox', '2026-11-13T03:12:00.000Z'),
];

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderList(opts: {
  sessions?: readonly DeviceSession[];
  load?: () => Promise<ActionResult<readonly DeviceSession[]>>;
  revoke?: (id: string) => Promise<ActionResult<null>>;
  logout?: () => void;
} = {}) {
  const load = vi.fn(opts.load ?? (() => Promise.resolve({ ok: true as const, value: opts.sessions ?? THREE })));
  const revoke = vi.fn(opts.revoke ?? (() => Promise.resolve({ ok: true as const, value: null })));
  const logout = vi.fn(opts.logout ?? (() => undefined));
  render(<SessionList load={load} revoke={revoke} logoutThisDevice={logout} now={() => NOW} />);
  return { load, revoke, logout };
}

const list = () => screen.getByRole('list', { name: SESSION_LIST_COPY.title });
const rows = () => within(list()).getAllByRole('listitem');
const title = () => screen.getByRole('heading', { level: 1, name: SESSION_LIST_COPY.title });

function liveServer(sessions: readonly unknown[]) {
  const server = new FakeServer();
  server.on('GET /api/sessions', () => ({ status: 200, body: { sessions } }));
  server.on('POST /api/auth/logout', () => ({ status: 204 }));
  return server;
}

function mountLive(server: FakeServer, path = '/') {
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

const WIRE = [
  { id: S_THIS, device_label: 'Mac · Chrome', created_at: '2026-11-01T00:00:00.000Z', last_seen_at: '2026-11-14T05:59:00.000Z', current: true },
  { id: S_PHONE, device_label: null, created_at: '2026-11-01T00:00:00.000Z', last_seen_at: '2026-11-10T01:00:00.000Z', current: false },
];

describe('UI-AC-12 진입·라우트·제목 포커스', () => {
  it('사이드바 「로그인한 기기」(member 역할에도 보임) → /settings/sessions, 제목에 포커스', async () => {
    installViewport(1280);
    const server = liveServer(WIRE);
    const { history } = mountLive(server);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.title }));
    await settle();
    expect(history.pathname()).toBe('/settings/sessions');
    expect(document.activeElement).toBe(title());
    expect(server.log).toContain('GET /api/sessions');
    expect(rows()).toHaveLength(2);
  });

  it('주소 /settings/sessions 직접 진입(새로고침) → 같은 화면', async () => {
    installViewport(1280);
    mountLive(liveServer(WIRE), '/settings/sessions');
    await settle();
    expect(title()).toBeTruthy();
    expect(screen.getByText(SESSION_LIST_COPY.unknownDevice)).toBeTruthy();
  });
});

describe('UI-AC-13 로딩·오류·시간 초과', () => {
  it('로딩 중 목록 aria-busy, 응답 후 해제', async () => {
    const d = deferred<ActionResult<readonly DeviceSession[]>>();
    renderList({ load: () => d.promise });
    expect(list().getAttribute('aria-busy')).toBe('true');
    await act(async () => d.resolve({ ok: true, value: THREE }));
    expect(list().hasAttribute('aria-busy')).toBe(false);
  });

  it.each([
    [{ ok: false, status: 'network' } as const, ERROR_COPY.network],
    [{ ok: false, status: 503 } as const, ERROR_COPY.server],
    [{ ok: false, status: 429 } as const, ERROR_COPY.rateLimited],
    [{ ok: false, status: 'network', timedOut: true } as const, ERROR_COPY.timeout],
  ])('실패 %o → ErrorState 원인 문구 + 「다시 시도」 = 같은 요청', async (failure, text) => {
    let n = 0;
    const { load } = renderList({
      load: () => {
        n += 1;
        return Promise.resolve(n === 1 ? failure : { ok: true, value: THREE });
      },
    });
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(text);
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(3);
  });
});

describe('UI-AC-14 정렬·이 기기 표지·대비', () => {
  it('이 기기 맨 위 + 「이 기기」 텍스트 표지, 나머지는 마지막 사용 내림차순, 이 기기 행에는 기기 로그아웃 버튼 없음', async () => {
    renderList();
    await settle();
    const [first, second, third] = rows();
    expect(first?.textContent).toContain('Mac · Chrome');
    expect(within(first!).getByText(SESSION_LIST_COPY.thisDevice)).toBeTruthy();
    expect(first?.querySelector('[data-session-logout]')).toBeNull();
    expect(within(first!).getByRole('button', { name: SESSION_LIST_COPY.logoutThisDevice })).toBeTruthy();
    expect(second?.textContent).toContain('Mac · Firefox');
    expect(third?.textContent).toContain('iPhone · Safari');
    expect(within(second!).queryByText(SESSION_LIST_COPY.thisDevice)).toBeNull();
  });

  it('마지막 사용 시각(G-66): 오늘·어제는 시각 포함, 그 전은 날짜만', async () => {
    renderList();
    await settle();
    expect(within(rows()[1]!).getByText(/^마지막 사용 어제 오후 12:12$/)).toBeTruthy();
    expect(within(rows()[2]!).getByText('마지막 사용 2026-11-10')).toBeTruthy();
    expect(lastUsedWhen('2026-11-14T05:59:00.000Z', NOW)).toBe('오늘 오후 2:59');
  });

  it('sortSessions는 입력 배열을 바꾸지 않는다', () => {
    const input = [...THREE];
    sortSessions(input);
    expect(input).toEqual(THREE);
  });

  it('「이 기기」 표지 --accent-text / --accent-bg 대비 4.5:1 이상(라이트·다크 실측)', async () => {
    const checkerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tools/check-design-tokens.ts');
    const checker = (await import(pathToFileURL(checkerPath).href)) as {
      contrastRatio(a: readonly number[], b: readonly number[]): number;
      parseHex(v: unknown): readonly [number, number, number] | undefined;
    };
    for (const scheme of ['light', 'dark'] as const) {
      const fg = checker.parseHex(tokens.colors[scheme]['--accent-text']?.value);
      const bg = checker.parseHex(tokens.colors[scheme]['--accent-bg']?.value);
      if (fg === undefined || bg === undefined) throw new Error(`${scheme} 토큰 없음`);
      expect(checker.contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('UI-AC-15 라벨 없음', () => {
  it('device_label null → 「알 수 없는 기기」, 같은 이름이 둘이면 버튼 이름에 마지막 사용 덧붙임', async () => {
    renderList({
      sessions: [
        session(S_THIS, 'Mac · Chrome', '2026-11-14T05:59:00.000Z', true),
        session(S_MAC, null, '2026-11-13T03:12:00.000Z'),
        session(S_PHONE, null, '2026-11-10T01:00:00.000Z'),
      ],
    });
    await settle();
    expect(screen.getAllByText(SESSION_LIST_COPY.unknownDevice)).toHaveLength(2);
    expect(screen.getByRole('button', { name: '알 수 없는 기기 로그아웃, 마지막 사용 어제 오후 12:12' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '알 수 없는 기기 로그아웃, 마지막 사용 2026-11-10' })).toBeTruthy();
  });

  it('라벨 하나뿐이면 버튼 이름 「{기기 라벨} 로그아웃」', async () => {
    renderList();
    await settle();
    expect(screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' })).toBeTruthy();
  });

  it('다른 기기 없음 → 이 기기 행 + 「다른 기기에서 로그인하지 않았습니다」', async () => {
    renderList({ sessions: [session(S_THIS, 'Mac · Chrome', '2026-11-14T05:59:00.000Z', true)] });
    await settle();
    expect(rows()).toHaveLength(1);
    expect(screen.getByText(SESSION_LIST_COPY.noOtherDevices)).toBeTruthy();
  });
});

describe('UI-AC-16 확인 Dialog·busy', () => {
  it('「로그아웃」 → Dialog(G-69), 요청 중 Esc·닫기·취소로 닫히지 않고 aria-busy', async () => {
    const d = deferred<ActionResult<null>>();
    const { revoke } = renderList({ revoke: () => d.promise });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' }));
    const dialog = screen.getByRole('dialog', { name: SESSION_LIST_COPY.confirmTitle });
    expect(dialog.textContent).toContain(SESSION_LIST_COPY.confirmBody('iPhone · Safari'));
    // 첫 포커스: 기존 Dialog 규칙(첫 포커스 가능 요소 = 「닫기」).
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '닫기' }));
    fireEvent.click(within(dialog).getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    expect(revoke).toHaveBeenCalledWith(S_PHONE);
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((within(dialog).getByRole('button', { name: '취소' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => d.resolve({ ok: true, value: null }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('「취소」 → 닫힘, 포커스는 트리거 「로그아웃」으로 복귀', async () => {
    renderList();
    await settle();
    const trigger = screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('UI-AC-17 성공: 행 제거·알림·포커스', () => {
  const confirmOn = async (name: string) => {
    const trigger = screen.getByRole('button', { name });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    await settle();
  };

  it('다음 행 「로그아웃」으로 포커스, G-71 알림, 목록 재요청', async () => {
    let n = 0;
    const { load } = renderList({
      load: () => {
        n += 1;
        return Promise.resolve({ ok: true, value: n === 1 ? THREE : THREE.filter((s) => s.id !== S_MAC) });
      },
    });
    await settle();
    await confirmOn('Mac · Firefox 로그아웃');
    expect(screen.queryByText('Mac · Firefox')).toBeNull();
    expect(screen.getByText(SESSION_LIST_COPY.done('Mac · Firefox'))).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('마지막 행이면 이전 다른 기기 행, 다른 기기가 없어지면 제목으로', async () => {
    let current = [...THREE];
    renderList({ load: () => Promise.resolve({ ok: true, value: current }) });
    await settle();
    current = current.filter((s) => s.id !== S_PHONE);
    await confirmOn('iPhone · Safari 로그아웃');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mac · Firefox 로그아웃' }));
    current = current.filter((s) => s.id !== S_MAC);
    await confirmOn('Mac · Firefox 로그아웃');
    expect(document.activeElement).toBe(title());
    expect(screen.getByText(SESSION_LIST_COPY.noOtherDevices)).toBeTruthy();
  });
});

describe('UI-AC-18 실패', () => {
  it.each([
    [{ ok: false, status: 'network', timedOut: true } as const, ERROR_COPY.timeout],
    [{ ok: false, status: 500 } as const, ERROR_COPY.server],
    [{ ok: false, status: 'network' } as const, ERROR_COPY.network],
  ])('%o → Dialog 안 「로그아웃하지 못했습니다.」 + 원인, busy 해제·다시 시도 가능', async (failure, text) => {
    const { revoke } = renderList({ revoke: () => Promise.resolve(failure) });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' }));
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert').textContent).toBe(`${SESSION_LIST_COPY.failed} ${text}`);
    expect(dialog.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    await settle();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('예외를 던져도 busy가 풀린다(settleAction)', async () => {
    renderList({ revoke: () => Promise.reject(new Error('boom')) });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' }));
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    await settle();
    expect(screen.getByRole('dialog').hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain(ERROR_COPY.network);
  });

  it('404 → ERROR_COPY.notFound + 「목록 새로 고침」 → Dialog 닫고 목록 재요청', async () => {
    const { load } = renderList({ revoke: () => Promise.resolve({ ok: false, status: 404 }) });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone · Safari 로그아웃' }));
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    await settle();
    expect(screen.getByRole('alert').querySelector('p')?.textContent).toBe(`${SESSION_LIST_COPY.failed} ${ERROR_COPY.notFound}`);
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: SESSION_LIST_COPY.confirm })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ERROR_COPY.refreshList }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('UI-AC-20 이 기기에서 로그아웃', () => {
  it('확인 없이 바로 호출', async () => {
    const { logout, revoke } = renderList();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.logoutThisDevice }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('LiveApp: POST /api/auth/logout → /login(세션 종료 문구 없음), DELETE 없음 — 사이드바 로그아웃과 같은 결과', async () => {
    installViewport(1280);
    const server = liveServer(WIRE);
    mountLive(server, '/settings/sessions');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: SESSION_LIST_COPY.logoutThisDevice }));
    await settle();
    expect(server.log).toContain('POST /api/auth/logout');
    expect(server.log.some((l) => l.startsWith('DELETE /api/sessions'))).toBe(false);
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    expect(screen.queryByText('세션이 종료되었습니다')).toBeNull();
  });

  it('LiveApp: 다른 기기 로그아웃은 DELETE /api/sessions/{id}에 CSRF 헤더를 싣는다', async () => {
    installViewport(1280);
    const server = liveServer(WIRE);
    let csrf: string | null = null;
    server.on(`DELETE /api/sessions/${S_PHONE}`, (_url, init) => {
      csrf = new Headers(init?.headers).get('X-CSRF-Token');
      return { status: 204 };
    });
    mountLive(server, '/settings/sessions');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '알 수 없는 기기 로그아웃' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: SESSION_LIST_COPY.confirm }));
    await settle();
    expect(csrf).toBe('csrf-1');
    expect(screen.getByText(SESSION_LIST_COPY.done(SESSION_LIST_COPY.unknownDevice))).toBeTruthy();
  });
});
