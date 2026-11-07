/** FR-AUTH-02 웹 보조 증거(DEV_DESIGN §6-2): 만료·폐기 세션의 401에서만 로그인 안내(S11 「세션이 종료되었습니다」). */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { SESSION_ENDED_TEXT } from '../../src/features/auth';
import { FakeServer, MemoryStorage, flush } from '../sync/fake-server.js';

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
  return { sources };
}

async function connected(server: FakeServer) {
  const { sources } = mount(server);
  await settle();
  expect(screen.getByLabelText('공간')).toBeTruthy();
  const source = sources.at(-1);
  if (source === undefined) throw new Error('no source');
  return source;
}

async function resumeWith(source: HttpDataSource) {
  await act(async () => {
    await source.resume();
  });
  await settle();
}

const loginButton = () => screen.queryByRole('button', { name: '로그인' });

describe('FR-AUTH-02 세션 만료 안내(웹)', () => {
  it('FR-AUTH-02 연결된 세션이 세션 확인 외 API(목록)에서 401을 받으면 로그인 화면에 세션 종료 안내', async () => {
    const server = new FakeServer();
    const source = await connected(server);
    server.on('GET /api/conversations', () => ({ status: 401 }));
    await resumeWith(source);
    expect(loginButton()).toBeTruthy();
    expect(screen.getByText(SESSION_ENDED_TEXT)).toBeTruthy();
    expect(screen.queryByLabelText('공간')).toBeNull();
  });

  it('FR-AUTH-02 연결된 세션의 세션 확인(GET /api/me) 401도 세션 종료 안내', async () => {
    const server = new FakeServer();
    const source = await connected(server);
    server.on('GET /api/me', () => ({ status: 401 }));
    await resumeWith(source);
    expect(screen.getByText(SESSION_ENDED_TEXT)).toBeTruthy();
  });

  it('FR-AUTH-02 첫 진입 401(연결된 적 없음)은 안내 없이 로그인 폼만', async () => {
    const server = new FakeServer();
    server.on('GET /api/me', () => ({ status: 401 }));
    mount(server);
    await settle();
    expect(loginButton()).toBeTruthy();
    expect(screen.queryByText(SESSION_ENDED_TEXT)).toBeNull();
  });

  it('FR-AUTH-02 500·네트워크 오류는 로그인 안내 없이 앱에 머문다', async () => {
    const server = new FakeServer();
    const source = await connected(server);
    server.on('GET /api/me', () => ({ status: 500 }));
    await resumeWith(source);
    server.on('GET /api/me', () => 'network');
    await resumeWith(source);
    expect(loginButton()).toBeNull();
    expect(screen.queryByText(SESSION_ENDED_TEXT)).toBeNull();
    expect(screen.getByLabelText('공간')).toBeTruthy();
  });

  it('FR-AUTH-02 사용자 로그아웃은 안내 없이 로그인 폼', async () => {
    const server = new FakeServer();
    server.on('POST /api/auth/logout', () => ({ status: 204 }));
    const source = await connected(server);
    await act(async () => {
      await source.logout();
    });
    await settle();
    expect(loginButton()).toBeTruthy();
    expect(screen.queryByText(SESSION_ENDED_TEXT)).toBeNull();
  });
});
