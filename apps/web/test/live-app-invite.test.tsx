/** Codex r2 P1: 운영 루트의 초대 링크(`#t=<token>`) → InviteAccept → `POST /api/invites/accept` → 연결. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { inviteAcceptRequestSchema } from '../../../packages/shared/src/index.js';
import { LiveApp } from '../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../src/data/http-source.js';
import { INVITE_UNUSABLE_TEXT } from '../src/features/auth';
import { FakeServer, ME, MemoryStorage, flush } from './sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(flush);
};

const TOKEN = 'invite-token-xyz';

function mount(server: FakeServer, hash: string) {
  const storage = new MemoryStorage();
  const sources: HttpDataSource[] = [];
  let current = hash;
  const cleared: string[] = [];
  render(
    <LiveApp
      fetch={server.fetch}
      readHash={() => current}
      clearHash={() => {
        cleared.push(current);
        current = '';
      }}
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
  return { storage, sources, cleared, hash: () => current };
}

function fill() {
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'new@x.test' } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
  fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: 'New' } });
  fireEvent.submit(screen.getByRole('button', { name: '수락' }).closest('form') as HTMLFormElement);
}

describe('LiveApp 초대 수락', () => {
  it('해시 초대 → 연결 시도 없이 수락 폼 → 계약 맞는 수락 요청 → 성공 시 연결', async () => {
    const server = new FakeServer();
    let accepted = false;
    const bodies: unknown[] = [];
    server.on('GET /api/me', () =>
      accepted ? { status: 200, body: { user: { id: ME, email: 'n@x', display_name: 'New', role: 'member' }, csrf_token: 'c' } } : { status: 401 },
    );
    server.on('POST /api/invites/accept', (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      bodies.push(body);
      accepted = inviteAcceptRequestSchema.safeParse(body).success;
      return accepted ? { status: 201, body: { user: { id: ME } } } : { status: 400 };
    });
    const { sources, storage, cleared, hash } = mount(server, `#t=${TOKEN}`);
    await settle();
    expect(screen.getByRole('button', { name: '수락' })).toBeTruthy();
    expect(server.log.some((l) => l.startsWith('GET /api/me'))).toBe(false);
    expect(sources).toHaveLength(0);
    expect(cleared).toEqual([`#t=${TOKEN}`]);
    expect(hash()).toBe('');

    fill();
    await settle();
    expect(bodies).toEqual([{ token: TOKEN, email: 'new@x.test', password: 'pw', display_name: 'New' }]);
    expect(screen.queryByRole('button', { name: '수락' })).toBeNull();
    expect(screen.getByLabelText('공간')).toBeTruthy();
    expect(sources.at(-1)?.getSnapshot().connection).toBe('connected');
    for (let i = 0; i < storage.length; i += 1) expect(storage.getItem(storage.key(i) ?? '')).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('만료·사용됨(4xx) → 정본 문구, 연결 시작 안 함', async () => {
    const server = new FakeServer();
    server.on('POST /api/invites/accept', () => ({ status: 410 }));
    const { sources } = mount(server, `#t=${TOKEN}`);
    await settle();
    fill();
    await settle();
    expect(screen.getByText(INVITE_UNUSABLE_TEXT)).toBeTruthy();
    expect(sources).toHaveLength(0);
  });

  it('초대 해시가 없으면 기존처럼 세션 확인부터 시작한다', async () => {
    const server = new FakeServer();
    const { sources, cleared } = mount(server, '');
    await settle();
    expect(sources).toHaveLength(1);
    expect(cleared).toEqual([]);
    expect(screen.queryByRole('button', { name: '수락' })).toBeNull();
  });
});
