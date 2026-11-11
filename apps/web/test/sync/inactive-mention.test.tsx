/**
 * QA D1: 세션 중 비활성화된 멤버는 같은 채널을 연 채로도 멘션 후보에서 빠진다.
 * 원인: `useConversationMembers`는 대화 ID·revision이 바뀔 때만 다시 읽는다 — 멤버 관리 왕복은 둘 다 바꾸지 않는다.
 * `GET /api/members`(활성만)에서 사라진 ID를 알면 DataSource가 snapshot `activeRevision`을 올리고 셸이 후보를 다시 읽는다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, flush, message } from './fake-server.js';

afterEach(cleanup);
// LiveApp이 주소를 `/c/:id`로 바꾼다 — 테스트마다 첫 화면에서 시작한다.
beforeEach(() => window.history.replaceState(null, '', '/'));

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world() {
  const server = new FakeServer();
  const state = { active: true };
  server.on(`GET /api/conversations/${CONV}/members`, () => ({
    status: 200,
    body: { members: state.active ? [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }] : [{ id: ME, display_name: 'A' }] },
  }));
  server.on('GET /api/members', () => ({ status: 200, body: { members: state.active ? [{ id: PEER, display_name: 'B', role: 'member' }] : [] } }));
  server.on('GET /api/users/names', () => ({ status: 200, body: { users: [{ id: PEER, display_name: 'B', status: 'disabled', kind: 'human' }] } }));
  server.on(`POST /api/admin/members/${PEER}/deactivate`, () => {
    state.active = false;
    return { status: 204 };
  });
  const ref: { ds?: HttpDataSource } = {};
  render(
    <LiveApp
      fetch={(input, init) => server.fetch(String(input), init)}
      createSource={(deps) => {
        ref.ds = createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => true,
          setTimer: () => 0,
          clearTimer: () => undefined,
        });
        return ref.ds;
      }}
    />,
  );
  return { server, state, ref };
}

/** general을 열고 작성기 `@` 후보 이름을 돌려준다(입력은 비운다). */
async function candidates(): Promise<readonly (string | null)[]> {
  const box = screen.getByLabelText('#general에 메시지 작성') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '@' } });
  const names = screen.queryAllByRole('option').map((o) => o.textContent);
  fireEvent.change(box, { target: { value: '' } });
  return names;
}

describe('QA D1 — 세션 중 비활성화된 멤버의 멘션 후보', () => {
  it('B가 활성 목록에서 사라지면 같은 채널 작성기 @ 후보에서도 빠진다', async () => {
    const { server, state, ref } = world();
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    expect(await candidates()).toEqual(['B']);

    // B 비활성화(다른 경로) → 멤버 관리 목록 재조회와 같은 `listMembers` — 대화 ID는 그대로.
    state.active = false;
    await act(async () => {
      await ref.ds?.listMembers?.();
    });
    await settle();
    expect(await candidates()).toEqual([]);
    expect(server.log.filter((l) => l === `GET /api/conversations/${CONV}/members`).length).toBeGreaterThanOrEqual(2);
  });

  it('멤버 관리에서 직접 비활성화(목록 재조회 없음)해도 후보에서 빠지고 작성자 이름은 「(비활성)」', async () => {
    const { server, ref } = world();
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1)], has_more: false } }));
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    expect(await candidates()).toEqual(['B']);
    expect(document.querySelector('[aria-label^="B, "]')).not.toBeNull();

    // MemberAdmin 「비활성화」 확인과 같은 호출 — 성공 뒤 목록(`listMembers`)을 다시 읽지 않는다.
    await act(async () => {
      expect(await ref.ds?.deactivateMember?.(PEER)).toEqual({ ok: true, value: null });
    });
    await settle();
    expect(await candidates()).toEqual([]);
    expect(document.querySelector('[aria-label^="B (비활성), "]')).not.toBeNull();
  });
});
