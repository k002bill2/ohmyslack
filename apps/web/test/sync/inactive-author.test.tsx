/**
 * 비활성 멤버가 남긴 메시지의 작성자 이름(G-50·G-51): 대화·워크스페이스 멤버 조회(활성만)에 없는 author_id는
 * `GET /api/users/names`로 한 번 더 찾는다. 비활성이면 「{이름} (비활성)」, 끝내 모르면 「알 수 없는 사용자」 — 빈 이름 0.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, message, setup, summary } from './fake-server.js';

afterEach(cleanup);

const GONE = U(3);
const LOST = U(4);
const DM = U(11);
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};
const nameCalls = (log: readonly string[]) => log.filter((l) => l.startsWith('GET /api/users/names')).length;
const goneReply = () => ({ status: 200, body: { users: [{ id: GONE, display_name: '떠난이', status: 'disabled', kind: 'human' }] } });

describe('비활성 작성자 이름(G-50·G-51)', () => {
  it('LiveApp: 비활성 작성자 메시지 → 「떠난이 (비활성)」 표시, 접근 이름에도 같은 표기', async () => {
    const server = new FakeServer();
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({
      status: 200,
      body: { messages: [message(1, { author_id: GONE, body: '예전 글' })], has_more: false },
    }));
    server.on(`GET /api/conversations/${CONV}/members`, () => ({ status: 200, body: { members: [{ id: ME, display_name: 'A' }] } }));
    server.on('GET /api/users/names', goneReply);
    render(
      <LiveApp
        fetch={(input, init) => server.fetch(String(input), init)}
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
    await settle();
    fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    expect(screen.getByText('예전 글')).toBeTruthy();
    expect(screen.getAllByText('떠난이 (비활성)').length).toBeGreaterThan(0);
    const item = document.querySelector('[aria-label^="떠난이 (비활성), "]');
    expect(item).not.toBeNull();
    expect(document.querySelector('[aria-label^=", "]')).toBeNull();
    expect(server.log.find((l) => l.startsWith('GET /api/users/names'))).toBe(`GET /api/users/names?ids=${GONE}`);
  });

  it('이름 조회 실패·응답에 없음 → 「알 수 없는 사용자」, 같은 ID는 다시 조회하지 않는다', async () => {
    const { server, ds } = setup();
    server.on('GET /api/users/names', () => ({ status: 500 }));
    await ds.start();
    ds.open?.(CONV);
    await flush();
    server.socket.push({ type: 'message.created', change_id: 1, conversation_id: CONV, message: message(1, { author_id: GONE }) });
    for (let i = 0; i < 8; i += 1) await flush();
    expect(ds.getSnapshot().messages.find((m) => m.id === message(1).id)?.author).toBe('알 수 없는 사용자');
    expect(nameCalls(server.log)).toBe(1);
    server.socket.push({ type: 'message.created', change_id: 2, conversation_id: CONV, message: message(2, { author_id: GONE }) });
    for (let i = 0; i < 8; i += 1) await flush();
    expect(nameCalls(server.log)).toBe(1);
    expect(ds.getSnapshot().messages.map((m) => m.author)).toEqual(['알 수 없는 사용자', '알 수 없는 사용자']);
    // 200이지만 응답에 없는 ID도 같은 대체 이름.
    server.on('GET /api/users/names', () => ({ status: 200, body: { users: [] } }));
    server.socket.push({ type: 'message.created', change_id: 3, conversation_id: CONV, message: message(3, { author_id: LOST }) });
    for (let i = 0; i < 8; i += 1) await flush();
    expect(nameCalls(server.log)).toBe(2);
    expect(ds.getSnapshot().messages.find((m) => m.id === message(3).id)?.author).toBe('알 수 없는 사용자');
    expect(ds.getSnapshot().messages.every((m) => m.author !== '')).toBe(true);
  });

  it('재조회 중 도착한 미지 작성자들은 이름 조회 한 번으로 묶는다', async () => {
    const { server, ds } = setup();
    server.on(`GET /api/conversations/${CONV}/members`, () => ({ status: 200, body: { members: [] } }));
    server.on('GET /api/users/names', (url) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      const known = [
        { id: GONE, display_name: '떠난이', status: 'disabled', kind: 'human' },
        { id: LOST, display_name: '잃은이', status: 'disabled', kind: 'bot' },
      ];
      return { status: 200, body: { users: known.filter((u) => ids.includes(u.id)) } };
    });
    await ds.start();
    ds.open?.(CONV);
    await flush();
    const base = nameCalls(server.log);
    server.socket.push({ type: 'message.created', change_id: 1, conversation_id: CONV, message: message(1, { author_id: GONE }) });
    server.socket.push({ type: 'message.created', change_id: 2, conversation_id: CONV, message: message(2, { author_id: LOST }) });
    for (let i = 0; i < 10; i += 1) await flush();
    expect(ds.getSnapshot().messages.map((m) => m.author)).toEqual(['떠난이 (비활성)', '잃은이 (비활성)']);
    expect(nameCalls(server.log) - base).toBeLessThanOrEqual(2);
  });

  it('비활성 상대와의 DM 이름도 「{이름} (비활성)」로 채운다', async () => {
    const { server, ds } = setup();
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: { conversations: [summary(), summary({ id: DM, kind: 'dm', name: null, peer_user_id: GONE })], next_cursor: null },
    }));
    server.on('GET /api/users/names', goneReply);
    await ds.start();
    for (let i = 0; i < 8; i += 1) await flush();
    expect(ds.getSnapshot().spaces.find((s) => s.id === DM)?.name).toBe('떠난이 (비활성)');
  });

  it('멤버 관리 목록·멘션 후보는 그대로 활성 멤버만이다', async () => {
    const { server, ds } = setup();
    server.on(`GET /api/conversations/${CONV}/members`, () => ({ status: 200, body: { members: [{ id: ME, display_name: 'A' }] } }));
    server.on('GET /api/users/names', goneReply);
    await ds.start();
    ds.open?.(CONV);
    await flush();
    server.socket.push({ type: 'message.created', change_id: 1, conversation_id: CONV, message: message(1, { author_id: GONE }) });
    for (let i = 0; i < 8; i += 1) await flush();
    expect(ds.getSnapshot().messages[0]?.author).toBe('떠난이 (비활성)');
    const members = await ds.listMembers?.();
    expect(members).toEqual({ ok: true, value: [{ id: PEER, displayName: 'B', role: 'member', kind: undefined }] });
    const candidates = await ds.listConversationMembers?.(CONV);
    expect(candidates).toEqual({ ok: true, value: [{ id: ME, displayName: 'A' }] });
  });
});
