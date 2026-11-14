/** 세션 종료(401)·직접 로그아웃 → 셸이 내려가며 첨부 초안을 버리고 진행 중 업로드를 끊는다. 다시 로그인한 작성기에 이전 칩이 없다(QA r2 관찰 3). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../src/data/http-source.js';
import type { UploadAttachmentOptions } from '../src/data/index.js';
import { FakeServer, ME, MemoryStorage, flush } from './sync/fake-server.js';
import { installViewport } from './helpers/viewport.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(flush);
};

function mount(server: FakeServer) {
  installViewport(1280);
  const storage = new MemoryStorage();
  const sources: HttpDataSource[] = [];
  const signals: (AbortSignal | undefined)[] = [];
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
        // 업로드는 응답 없이 걸어 둔다 — 셸이 내려갈 때 끊기는지만 본다.
        const withUpload: HttpDataSource = {
          ...ds,
          uploadAttachment: (_conversationId: string, _file: Blob, options?: UploadAttachmentOptions) => {
            signals.push(options?.signal);
            return new Promise(() => undefined);
          },
        };
        sources.push(withUpload);
        return withUpload;
      }}
    />,
  );
  return { sources, signals };
}

const pickPdf = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'general' }));
  });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.pdf')] } });
  });
};

const login = async () => {
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'a@x.test' } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
  fireEvent.submit(screen.getByRole('button', { name: '로그인' }).closest('form') as HTMLFormElement);
  await settle();
};

describe('LiveApp — 첨부 초안 수명', () => {
  it.each(['401', 'logout'] as const)('%s: 진행 중 업로드 abort, 다시 로그인한 작성기에 이전 칩 없음', async (how) => {
    const server = new FakeServer();
    let authed = true;
    server.on('GET /api/me', () =>
      authed ? { status: 200, body: { user: { id: ME, email: 'a@x', display_name: 'A', role: 'member' }, csrf_token: 'c' } } : { status: 401 },
    );
    server.on('POST /api/auth/login', () => {
      authed = true;
      return { status: 204 };
    });
    server.on('POST /api/auth/logout', () => ({ status: 204 }));
    const { sources, signals } = mount(server);
    await settle();
    await pickPdf();
    expect(document.querySelectorAll('.composer-chip')).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    authed = false;
    await act(async () => {
      if (how === '401') await sources.at(-1)?.resume();
      else await sources.at(-1)?.logout();
    });
    await settle();
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    expect(signals[0]?.aborted).toBe(true);

    await login();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'general' }));
    });
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    expect(document.querySelectorAll('.composer-chip')).toHaveLength(0);
  });
});
