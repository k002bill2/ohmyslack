import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, flush, setup } from './fake-server.js';

/**
 * W-16 F-5(QA-FR-SYNC-07): iOS 복귀 직후 죽은 소켓이 아직 OPEN으로 보이다가 복귀 절차 도중 늦게 닫히면,
 * 「최신 상태 확인 중…」(배지·구분선 보류)이 catch-up 도중 「다시 연결 중…」으로 덮여 보류가 풀리면 안 된다.
 */
describe('복귀 중 늦은 WS 종료(F-5)', () => {
  it('catch-up이 끝나기 전에는 catching-up 유지, 끝난 뒤 소켓이 없으면 reconnecting, 재연결·구독 후 connected', async () => {
    const timers: Array<() => void> = [];
    const { server, ds, storage } = setup({ setTimer: (fn: () => void) => (timers.push(fn), timers.length) });
    writeCheckpoint(ME, 5, storage);
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().connection).toBe('connected');

    // 백그라운드 복귀: 기존 소켓은 OPEN으로 보이지만 죽어 있다. catch-up 요청 중에 늦은 종료가 도착한다.
    const zombie = server.socket;
    let closed = false;
    server.on('GET /api/sync', (url) => {
      if (!closed) {
        closed = true;
        zombie.serverClose(1006);
      }
      return { status: 200, body: { changes: [], through_cursor: Number(url.searchParams.get('after')), scanned_through: 0, has_more: false, next_cursor: 0 } };
    });
    const states: Array<{ connection: string; listLoaded: boolean }> = [];
    const listCalls = () => server.log.filter((l) => l === 'GET /api/conversations').length;
    const listBefore = listCalls();
    let last = ds.getSnapshot().connection;
    const unsubscribe = ds.subscribe(() => {
      const now = ds.getSnapshot().connection;
      if (now !== last) states.push({ connection: now, listLoaded: listCalls() > listBefore });
      last = now;
    });

    const done = ds.resume();
    for (let i = 0; i < 6; i++) await flush();
    expect(closed).toBe(true);
    // 목록까지 받기 전에는 보류(catching-up)가 풀리지 않는다.
    expect(states.filter((s) => s.connection !== 'catching-up' && !s.listLoaded)).toEqual([]);
    expect(ds.getSnapshot().connection).toBe('reconnecting');

    // 재연결 타이머 → 새 소켓 열림 → 구독 ACK → 연결됨.
    for (const fn of timers.splice(0)) fn();
    expect(await done).toBe(true);
    unsubscribe();
    expect(states.map((s) => s.connection)).toEqual(['catching-up', 'reconnecting', 'connected']);
    expect(server.sockets.length).toBe(2);
  });
});
