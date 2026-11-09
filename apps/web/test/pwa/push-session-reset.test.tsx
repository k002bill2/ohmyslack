/** W-23b: 세션 종료(401·로그아웃) 시 PushBotHint 닫음 표시가 초기화된다(메모리 전용, B7). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { SESSION_ENDED_TEXT } from '../../src/features/auth';
import { PushBotHint, resetPushBotHint } from '../../src/features/pwa/PushBotHint.js';
import type { PushEnv } from '../../src/features/pwa/PushSettings.js';
import { PUSH_SETTINGS_COPY as C } from '../../src/ui/copy.js';
import { FakeServer, MemoryStorage, flush } from '../sync/fake-server.js';

const env: PushEnv = {
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
  standalone: () => false,
  supported: true,
  permission: () => 'default',
  requestPermission: async () => 'default',
  pushManager: async () => ({ getSubscription: async () => null, subscribe: vi.fn() }),
};
const pushServer = { vapidPublicKey: async () => 'BEl62iUY', register: async () => 'id', unregister: async () => undefined };

afterEach(() => {
  cleanup();
  resetPushBotHint();
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(flush);
};

describe('W-23b 세션 종료 시 알림 안내 초기화', () => {
  it('안내를 닫은 뒤 세션이 끝나면 다음 진입에서 안내가 다시 보인다', async () => {
    render(<PushBotHint env={env} server={pushServer} />);
    fireEvent.click(screen.getByRole('button', { name: C.dismissHint }));
    expect(screen.queryByText(C.botHint)).toBeNull();
    cleanup();

    const server = new FakeServer();
    const sources: HttpDataSource[] = [];
    render(
      <LiveApp
        fetch={server.fetch}
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
    await settle();
    server.on('GET /api/me', () => ({ status: 401 }));
    await act(async () => {
      await sources.at(-1)?.resume();
    });
    await settle();
    expect(screen.getByText(SESSION_ENDED_TEXT)).toBeTruthy();
    cleanup();

    render(<PushBotHint env={env} server={pushServer} />);
    expect(screen.getByText(C.botHint)).toBeTruthy();
  });
});
