/**
 * QA D1: 세션 중 비활성화된 멤버는 같은 채널을 연 채로도 멘션 후보에서 빠진다.
 * 원인: `useConversationMembers`는 대화 ID·revision이 바뀔 때만 다시 읽는다 — 멤버 관리 왕복은 둘 다 바꾸지 않는다.
 * `GET /api/members`(활성만)에서 사라진 ID를 알면 DataSource가 snapshot `activeRevision`을 올리고 셸이 후보를 다시 읽는다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, flush } from './fake-server.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

describe('QA D1 — 세션 중 비활성화된 멤버의 멘션 후보', () => {
  it('B가 활성 목록에서 사라지면 같은 채널 작성기 @ 후보에서도 빠진다', async () => {
    const server = new FakeServer();
    let active = true;
    server.on(`GET /api/conversations/${CONV}/members`, () => ({
      status: 200,
      body: { members: active ? [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }] : [{ id: ME, display_name: 'A' }] },
    }));
    server.on('GET /api/members', () => ({ status: 200, body: { members: active ? [{ id: PEER, display_name: 'B', role: 'member' }] : [] } }));
    server.on('GET /api/users/names', () => ({ status: 200, body: { users: [{ id: PEER, display_name: 'B', status: 'disabled', kind: 'human' }] } }));
    let ds: HttpDataSource | undefined;
    render(
      <LiveApp
        fetch={(input, init) => server.fetch(String(input), init)}
        createSource={(deps) => {
          ds = createHttpDataSource({
            ...deps,
            wsUrl: 'wss://oms.test/api/ws',
            createSocket: server.createSocket,
            storage: new MemoryStorage(),
            isOnline: () => true,
            setTimer: () => 0,
            clearTimer: () => undefined,
          });
          return ds;
        }}
      />,
    );
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    const box = screen.getByLabelText('#general에 메시지 작성') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['B']);
    fireEvent.change(box, { target: { value: '' } });

    // B 비활성화(다른 경로) → 멤버 관리 목록 재조회와 같은 `listMembers` — 대화 ID는 그대로.
    active = false;
    await act(async () => {
      await ds?.listMembers?.();
    });
    await settle();
    fireEvent.change(box, { target: { value: '@' } });
    expect(screen.queryAllByRole('option').map((o) => o.textContent)).toEqual([]);
    expect(server.log.filter((l) => l === `GET /api/conversations/${CONV}/members`).length).toBeGreaterThanOrEqual(2);
  });
});
