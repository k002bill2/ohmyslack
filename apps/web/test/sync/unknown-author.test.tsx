/**
 * W-10k 결함 A: 세션 시작 뒤 합류한 멤버의 메시지 작성자가 UUID로 보이던 문제.
 * 처음 보는 author_id → 대화별 1회 in-flight로 멤버 재조회 → 이름 갱신·emit. 실패해도 무한 재시도하지 않는다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, message, setup } from './fake-server.js';

afterEach(cleanup);

const NEWBIE = U(3);
const LATE = U(4);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};
const memberCalls = (log: readonly string[]) => log.filter((l) => l.startsWith(`GET /api/conversations/${CONV}/members`) || l === 'GET /api/members').length;

describe('미지 작성자 이름 재조회(W-10k A)', () => {
  it('LiveApp: 세션 뒤 합류한 멤버의 WS 메시지 → 작성자 이름 표시, 화면에 UUID 0건, 재조회 1회', async () => {
    const server = new FakeServer();
    let joined = false;
    const gate: { release?: () => void } = {};
    server.on(`GET /api/conversations/${CONV}/members`, () => ({
      status: 200,
      body: { members: [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }, ...(joined ? [{ id: NEWBIE, display_name: '새멤버' }] : [])] },
    }));
    render(
      <LiveApp
        fetch={async (input, init) => {
          if (joined && String(input).includes(`/api/conversations/${CONV}/members`) && gate.release === undefined) {
            await new Promise<void>((r) => {
              gate.release = r;
            });
          }
          return server.fetch(String(input), init);
        }}
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
    joined = true;
    const before = memberCalls(server.log);
    // 같은 미지 작성자의 메시지 2개가 재조회 응답 전에 도착해도 재조회는 1회.
    await act(async () => {
      server.socket.push({ type: 'message.created', change_id: 1, conversation_id: CONV, message: message(1, { author_id: NEWBIE, body: '첫 인사' }) });
      server.socket.push({ type: 'message.created', change_id: 2, conversation_id: CONV, message: message(2, { author_id: NEWBIE, body: '두 번째' }) });
    });
    await settle();
    expect(screen.getByText('첫 인사')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(UUID_RE);
    await act(async () => {
      gate.release?.();
    });
    await settle();
    expect(memberCalls(server.log) - before).toBe(1);
    expect(screen.getAllByText('새멤버').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it('재조회 실패: 기존 표시 유지·무한 재시도 없음, 다음 미지 ID에서만 다시 시도', async () => {
    const { server, ds } = setup();
    server.on(`GET /api/conversations/${CONV}/members`, () => ({ status: 500 }));
    server.on('GET /api/members', () => ({ status: 200, body: { members: [{ id: PEER, display_name: 'B', role: 'member' }] } }));
    await ds.start();
    ds.open?.(CONV);
    await flush();
    const base = memberCalls(server.log);
    server.socket.push({ type: 'message.created', change_id: 1, conversation_id: CONV, message: message(1, { author_id: NEWBIE }) });
    for (let i = 0; i < 6; i += 1) await flush();
    // 대화 멤버 실패 → /api/members 대체 1회, 그래도 없으면 멈춘다.
    expect(memberCalls(server.log) - base).toBe(2);
    expect(ds.getSnapshot().messages.find((m) => m.id === message(1).id)?.author).toBe('');
    // 같은 미지 ID의 메시지가 또 와도 다시 부르지 않는다.
    server.socket.push({ type: 'message.created', change_id: 2, conversation_id: CONV, message: message(2, { author_id: NEWBIE }) });
    for (let i = 0; i < 6; i += 1) await flush();
    expect(memberCalls(server.log) - base).toBe(2);
    // 다른 미지 ID → 다시 시도, 이번엔 성공해 이미 받은 메시지 작성자도 갱신된다.
    server.on(`GET /api/conversations/${CONV}/members`, () => ({
      status: 200,
      body: { members: [{ id: NEWBIE, display_name: '새멤버' }, { id: LATE, display_name: '늦게' }] },
    }));
    server.socket.push({ type: 'message.created', change_id: 3, conversation_id: CONV, message: message(3, { author_id: LATE }) });
    for (let i = 0; i < 6; i += 1) await flush();
    expect(memberCalls(server.log) - base).toBe(3);
    const authors = ds.getSnapshot().messages.map((m) => m.author);
    expect(authors).toEqual(['새멤버', '새멤버', '늦게']);
  });

  it('초기 이력(REST)의 미지 작성자도 재조회해 이름을 채운다', async () => {
    const { server, ds } = setup();
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1, { author_id: NEWBIE })], has_more: false } }));
    server.on(`GET /api/conversations/${CONV}/members`, () => ({ status: 200, body: { members: [{ id: NEWBIE, display_name: '새멤버' }] } }));
    await ds.start();
    ds.open?.(CONV);
    for (let i = 0; i < 6; i += 1) await flush();
    expect(ds.getSnapshot().messages[0]?.author).toBe('새멤버');
  });
});
