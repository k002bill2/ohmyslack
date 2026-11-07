/** 운영 루트(LiveApp): 세션 없음 → 로그인 → 연결, 연결 후 401 → 본문 비우고 「세션이 종료되었습니다」(S11). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../src/data/http-source.js';
import { SESSION_ENDED_TEXT } from '../src/features/auth';
import { readCheckpoint, writeCheckpoint } from '../src/features/sync';
import { FakeServer, ME, MemoryStorage, flush } from './sync/fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(flush);
};

function mount(server: FakeServer) {
  const storage = new MemoryStorage();
  const sources: HttpDataSource[] = [];
  render(
    <LiveApp
      fetch={server.fetch}
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
  return { storage, sources };
}

describe('LiveApp', () => {
  it('세션 없음(401) → 로그인 폼(세션 종료 문구 없음) → 로그인 성공 시 연결', async () => {
    const server = new FakeServer();
    let authed = false;
    server.on('GET /api/me', () =>
      authed ? { status: 200, body: { user: { id: ME, email: 'a@x', display_name: 'A', role: 'member' }, csrf_token: 'c' } } : { status: 401 },
    );
    server.on('POST /api/auth/login', (_url, init) => {
      authed = JSON.parse(String(init?.body)).password === 'pw';
      return authed ? { status: 204 } : { status: 401 };
    });
    const { sources } = mount(server);
    await settle();
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    expect(screen.queryByText(SESSION_ENDED_TEXT)).toBeNull();

    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'a@x.test' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
    fireEvent.submit(screen.getByRole('button', { name: '로그인' }).closest('form') as HTMLFormElement);
    await settle();
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
    expect(screen.getByLabelText('공간')).toBeTruthy();
    expect(sources.at(-1)?.getSnapshot().connection).toBe('connected');
    expect(server.log).toContain('POST /api/auth/login');
  });

  it('연결 후 401 → 본문·checkpoint 삭제, 로그인 폼에 「세션이 종료되었습니다」', async () => {
    const server = new FakeServer();
    const { sources, storage } = mount(server);
    await settle();
    expect(screen.getByLabelText('공간')).toBeTruthy();
    writeCheckpoint(ME, 7, storage);
    server.on('GET /api/me', () => ({ status: 401 }));
    await act(async () => {
      await sources.at(-1)?.resume();
    });
    await settle();
    expect(screen.getByText(SESSION_ENDED_TEXT)).toBeTruthy();
    expect(screen.queryByLabelText('공간')).toBeNull();
    expect(readCheckpoint(ME, storage)).toBeNull();
    expect(sources.at(-1)?.getSnapshot().spaces).toEqual([]);
  });
});
