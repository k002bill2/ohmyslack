/** Codex r1 지적 회귀 테스트(P1×2, P2 일부). */
import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, PEER, U, flush, message, setup, summary } from './fake-server.js';

describe('Codex r1 회귀', () => {
  it('P1 전송 대기 항목의 createdAt은 유효한 시각이다', async () => {
    const { server, ds, storage } = setup({ newClientMessageId: () => U(900) });
    writeCheckpoint(ME, 0, storage);
    server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 503 }));
    ds.open?.(CONV);
    await ds.resume();
    ds.send({ conversationId: CONV }, 'hi');
    await flush();
    const pending = ds.getSnapshot().messages.find((m) => m.pending !== undefined);
    expect(pending?.body).toBe('hi');
    expect(Number.isNaN(new Date(pending?.createdAt ?? '').getTime())).toBe(false);
  });

  it('P1 410 snapshot은 정본: live로 반영된 옛 본문을 snapshot 본문으로 교체한다', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    ds.open?.(CONV);
    await ds.resume();
    server.socket.push({ type: 'message.created', conversation_id: CONV, change_id: 50, message: message(1, { body: 'old' }) });
    expect(ds.getSnapshot().messages.find((m) => m.id === U(101))?.body).toBe('old');
    server.on('GET /api/sync', (url) =>
      url.searchParams.get('after') === '0'
        ? { status: 410 }
        : { status: 200, body: { changes: [], through_cursor: 60, scanned_through: 60, has_more: false, next_cursor: 60 } },
    );
    server.on('GET /api/sync/snapshot', () => ({
      status: 200,
      body: { snapshot_cursor: 60, conversation_id: CONV, messages: [message(1, { body: 'edited' })], has_more: false, next_before_seq: null },
    }));
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().messages.find((m) => m.id === U(101))?.body).toBe('edited');
  });

  it('P2 /api/me 성공 + /api/sync 네트워크 오류 반복 → 재시도 1회 후 끊김, 무한 재호출 없음', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => 'network');
    expect(await ds.resume()).toBe(false);
    expect(server.log.filter((l) => l === 'GET /api/me')).toHaveLength(2);
    expect(ds.getSnapshot().connection).toBe('offline');
  });

  it('P2 대화 목록은 next_cursor 끝까지 조회하고, 멤버 이름을 먼저 읽어 DM 이름을 채운다', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    const DM = U(11);
    server.on('GET /api/conversations', (url) =>
      url.searchParams.get('after') === null
        ? { status: 200, body: { conversations: [summary()], next_cursor: CONV } }
        : { status: 200, body: { conversations: [summary({ id: DM, kind: 'dm', name: null, peer_user_id: PEER })], next_cursor: null } },
    );
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().spaces.map((s) => s.name)).toEqual(['general', 'B']);
    expect(server.log.indexOf('GET /api/members')).toBeLessThan(server.log.indexOf('GET /api/sync?after=0'));
  });

  it('P2 세션 종료 뒤 늦게 끝난 전송 실패가 본문을 되살리지 않는다', async () => {
    const { server, ds, storage } = setup({ newClientMessageId: () => U(901) });
    writeCheckpoint(ME, 0, storage);
    ds.open?.(CONV);
    await ds.resume();
    server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 401 }));
    ds.send({ conversationId: CONV }, 'secret');
    await flush();
    await flush();
    expect(ds.getSnapshot().messages).toEqual([]);
  });
});
